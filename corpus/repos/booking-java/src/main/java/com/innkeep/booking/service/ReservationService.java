package com.innkeep.booking.service;

import static net.logstash.logback.argument.StructuredArguments.kv;

import com.innkeep.booking.domain.CancellationPolicy;
import com.innkeep.booking.domain.ConflictException;
import com.innkeep.booking.domain.LedgerEntry;
import com.innkeep.booking.domain.LedgerKind;
import com.innkeep.booking.domain.Money;
import com.innkeep.booking.domain.NotFoundException;
import com.innkeep.booking.domain.Reservation;
import com.innkeep.booking.domain.ReservationStatus;
import com.innkeep.booking.domain.RoomType;
import com.innkeep.booking.domain.ValidationException;
import com.innkeep.booking.persistence.InventoryRepository;
import com.innkeep.booking.persistence.LedgerEntryRepository;
import com.innkeep.booking.persistence.ReservationRepository;
import com.innkeep.booking.persistence.StatusCount;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.util.EnumMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Pageable;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Reads, cancels and checks in reservations. Cancellation is idempotent: a second cancel is a
 * conflict and never a second refund. The reservation row is flushed before the inventory moves, so
 * of two concurrent cancels the loser fails on the version and retries into the conflict.
 */
@Service
public class ReservationService {

  private static final Logger LOG = LoggerFactory.getLogger(ReservationService.class);

  private final ReservationRepository reservations;
  private final InventoryRepository inventory;
  private final LedgerEntryRepository ledger;
  private final PaymentGateway payments;
  private final Clock clock;
  private final TransactionTemplate tx;
  private final OptimisticRetry retry;

  public ReservationService(
      ReservationRepository reservations,
      InventoryRepository inventory,
      LedgerEntryRepository ledger,
      PaymentGateway payments,
      Clock clock,
      TransactionTemplate tx,
      OptimisticRetry retry) {
    this.reservations = reservations;
    this.inventory = inventory;
    this.ledger = ledger;
    this.payments = payments;
    this.clock = clock;
    this.tx = tx;
    this.retry = retry;
  }

  public Reservation get(String reference) {
    return reservations
        .findByReference(reference)
        .orElseThrow(() -> new NotFoundException("reservation", reference));
  }

  /** One page ordered by check-in date; blank filters are ignored. */
  public Page<Reservation> search(
      String propertyCode,
      ReservationStatus status,
      LocalDate from,
      LocalDate to,
      String guestEmail,
      String guestName,
      Pageable page) {
    if (from != null && to != null && to.isBefore(from)) {
      throw new ValidationException("'to' must not be before 'from'");
    }
    String email =
        guestEmail == null || guestEmail.isBlank()
            ? null
            : guestEmail.trim().toLowerCase(Locale.ROOT);
    return reservations.search(
        propertyCode, status, from, to, email, guestNamePattern(guestName), page);
  }

  /**
   * The name filter is a case-insensitive "contains"; SQL wildcards typed by the caller are dropped
   * so they cannot widen the match.
   */
  private static String guestNamePattern(String guestName) {
    if (guestName == null || guestName.isBlank()) {
      return null;
    }
    String plain = guestName.replaceAll("[%_\\\\]", "").trim().toLowerCase(Locale.ROOT);
    return "%" + plain + "%";
  }

  public CancellationOutcome cancel(String reference) {
    return retry.run(
        () ->
            tx.execute(
                status -> {
                  Reservation reservation = get(reference);
                  Instant now = clock.instant();
                  Money refund =
                      CancellationPolicy.of(reservation.getProperty())
                          .refund(reservation.getTotal(), reservation.getCheckIn(), now);
                  reservation.cancel(now);
                  reservations.saveAndFlush(reservation);
                  releaseBooked(reservation);
                  if (refund.isPositive()) {
                    String gatewayReference =
                        payments.refund("refund-" + reservation.getId(), refund);
                    ledger.save(
                        new LedgerEntry(
                            reservation.getId(),
                            LedgerKind.REFUND,
                            refund,
                            "cancellation",
                            gatewayReference,
                            now));
                  }
                  LOG.info(
                      "reservation cancelled",
                      kv("reservationId", reservation.getId()),
                      kv("refundAmount", refund.amount()));
                  return new CancellationOutcome(reservation, refund);
                }));
  }

  public Reservation checkIn(String reference) {
    return retry.run(
        () ->
            tx.execute(
                status -> {
                  Reservation reservation = get(reference);
                  Instant now = clock.instant();
                  LocalDate today = LocalDate.ofInstant(now, reservation.getProperty().zone());
                  reservation.checkIn(now, today);
                  LOG.info("guest checked in", kv("reservationId", reservation.getId()));
                  return reservations.saveAndFlush(reservation);
                }));
  }

  /**
   * Marks checked-in stays as completed once their check-out date has been reached in the
   * property's own time zone, and returns how many were completed. Stays are read in id order in
   * batches of {@code batchSize}, each batch in its own unit of work, so a stay whose zone is still
   * before its check-out date does not hide the departed stays read after it.
   */
  public int completeDepartedStays(int batchSize) {
    int completed = 0;
    long cursor = 0;
    DepartureBatch batch;
    do {
      batch = completeDepartureBatch(cursor, batchSize);
      completed += batch.completed();
      cursor = batch.lastId();
    } while (batch.read() == batchSize);
    return completed;
  }

  /** One pass of {@link #completeDepartedStays}: how many stays were read and completed. */
  record DepartureBatch(long lastId, int read, int completed) {}

  private DepartureBatch completeDepartureBatch(long afterId, int batchSize) {
    return retry.run(
        () ->
            tx.execute(
                status -> {
                  Instant now = clock.instant();
                  List<Reservation> batch =
                      reservations.findBatchAfter(
                          ReservationStatus.CHECKED_IN, afterId, PageRequest.of(0, batchSize));
                  long lastId = afterId;
                  int completed = 0;
                  for (Reservation reservation : batch) {
                    lastId = reservation.getId();
                    LocalDate today = LocalDate.ofInstant(now, reservation.getProperty().zone());
                    if (reservation.completeIfDeparted(now, today)) {
                      completed++;
                    }
                  }
                  return new DepartureBatch(lastId, batch.size(), completed);
                }));
  }

  public ReservationLedger ledger(String reference) {
    Reservation reservation = get(reference);
    return new ReservationLedger(
        reservation, ledger.findByReservationIdOrderByIdAsc(reservation.getId()));
  }

  /**
   * What cancelling the reservation at {@code at} (now, when null) would refund. Read-only: the
   * reservation is not changed and no money moves.
   */
  public CancellationQuote quoteCancellation(String reference, Instant at) {
    Reservation reservation = get(reference);
    if (reservation.getStatus() != ReservationStatus.CONFIRMED) {
      throw new ConflictException(
          "reservation " + reference + " is " + reservation.getStatus() + ", not cancellable");
    }
    Instant when = at == null ? clock.instant() : at;
    CancellationPolicy policy = CancellationPolicy.of(reservation.getProperty());
    LocalDate checkIn = reservation.getCheckIn();
    return new CancellationQuote(
        when,
        policy.refundPercent(checkIn, when),
        policy.refund(reservation.getTotal(), checkIn, when));
  }

  /** The number of reservations in each status, zero for the statuses with none. */
  public Map<ReservationStatus, Long> countByStatus() {
    var counts = new EnumMap<ReservationStatus, Long>(ReservationStatus.class);
    for (ReservationStatus status : ReservationStatus.values()) {
      counts.put(status, 0L);
    }
    for (StatusCount row : reservations.countByStatus()) {
      counts.put(row.getStatus(), row.getTotal());
    }
    return counts;
  }

  private void releaseBooked(Reservation reservation) {
    RoomType type = reservation.getRoomType();
    for (LocalDate night : reservation.getStay().nightDates()) {
      if (inventory.releaseBooked(type.getId(), night, reservation.getRooms()) == 0) {
        throw new IllegalStateException(
            "inventory for "
                + type.getCode()
                + " on "
                + night
                + " does not cover reservation "
                + reservation.getId());
      }
    }
  }
}
