package com.innkeep.booking.service;

import com.innkeep.booking.config.BookingConfig;
import com.innkeep.booking.domain.ConflictException;
import com.innkeep.booking.domain.DateRange;
import com.innkeep.booking.domain.GuestDetails;
import com.innkeep.booking.domain.Hold;
import com.innkeep.booking.domain.HoldExpiredException;
import com.innkeep.booking.domain.HoldStatus;
import com.innkeep.booking.domain.InsufficientAvailabilityException;
import com.innkeep.booking.domain.LedgerEntry;
import com.innkeep.booking.domain.LedgerKind;
import com.innkeep.booking.domain.NotFoundException;
import com.innkeep.booking.domain.PricingEngine;
import com.innkeep.booking.domain.Quote;
import com.innkeep.booking.domain.ReferenceCode;
import com.innkeep.booking.domain.Reservation;
import com.innkeep.booking.domain.RoomType;
import com.innkeep.booking.domain.SeasonalRate;
import com.innkeep.booking.domain.ValidationException;
import com.innkeep.booking.persistence.HoldRepository;
import com.innkeep.booking.persistence.HoldStatusCount;
import com.innkeep.booking.persistence.InventoryRepository;
import com.innkeep.booking.persistence.LedgerEntryRepository;
import com.innkeep.booking.persistence.ReservationRepository;
import com.innkeep.booking.persistence.SeasonalRateRepository;
import jakarta.persistence.EntityManager;
import jakarta.persistence.LockTimeoutException;
import jakarta.persistence.PessimisticLockException;
import java.security.SecureRandom;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.util.EnumMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.dao.PessimisticLockingFailureException;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Pageable;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Holds rooms, confirms them into reservations and releases them. Every change to inventory is a
 * conditional update per night, applied in ascending night order, so two requests for the last room
 * cannot both succeed and two holds never lock nights in opposite orders. The hold row is written
 * before inventory is touched: if a concurrent request already changed it, the version check fails
 * there and nothing has been moved yet.
 */
@Service
public class HoldService {

  private final CatalogService catalog;
  private final InventoryRepository inventory;
  private final HoldRepository holds;
  private final ReservationRepository reservations;
  private final LedgerEntryRepository ledger;
  private final SeasonalRateRepository seasonalRates;
  private final PaymentGateway payments;
  private final BookingConfig config;
  private final Clock clock;
  private final TransactionTemplate tx;
  private final EntityManager entities;
  private final OptimisticRetry retry;
  private final SecureRandom random = new SecureRandom();

  public HoldService(
      CatalogService catalog,
      InventoryRepository inventory,
      HoldRepository holds,
      ReservationRepository reservations,
      LedgerEntryRepository ledger,
      SeasonalRateRepository seasonalRates,
      PaymentGateway payments,
      BookingConfig config,
      Clock clock,
      TransactionTemplate tx,
      OptimisticRetry retry,
      EntityManager entities) {
    this.catalog = catalog;
    this.inventory = inventory;
    this.holds = holds;
    this.reservations = reservations;
    this.ledger = ledger;
    this.seasonalRates = seasonalRates;
    this.payments = payments;
    this.config = config;
    this.clock = clock;
    this.tx = tx;
    this.retry = retry;
    this.entities = entities;
  }

  /** Prices the stay and holds the rooms for every night, or none of them. */
  public Hold create(
      String propertyCode,
      String roomTypeCode,
      DateRange stay,
      int roomCount,
      int guests,
      GuestDetails guest) {
    config.requireWithinLimits(stay, roomCount);
    return tx.execute(
        status -> {
          RoomType type = catalog.roomType(propertyCode, roomTypeCode);
          LocalDate today = LocalDate.ofInstant(clock.instant(), type.getProperty().zone());
          if (stay.checkIn().isBefore(today)) {
            throw new ValidationException(
                "check-in " + stay.checkIn() + " is before today at the property");
          }
          List<SeasonalRate> rates =
              seasonalRates.findOverlapping(
                  List.of(type.getId()), stay.checkIn(), stay.lastNight());
          Quote quote =
              PricingEngine.quote(type.getProperty(), type, rates, stay, roomCount, guests);
          for (LocalDate night : stay.nightDates()) {
            if (inventory.holdRooms(type.getId(), night, roomCount) == 0) {
              throw new InsufficientAvailabilityException(type.getCode(), night);
            }
          }
          return holds.save(
              new Hold(
                  type.getProperty(),
                  type,
                  stay,
                  roomCount,
                  guests,
                  guest,
                  quote,
                  clock.instant(),
                  config.holdTtl()));
        });
  }

  public Hold get(UUID id) {
    return holds.findById(id).orElseThrow(() -> new NotFoundException("hold", id));
  }

  /**
   * Reads the hold under a lock on its own row, which every state change takes. The associations
   * are lazy and load without locks, so they are loaded here, inside the transaction.
   */
  private Hold lockedGet(UUID id) {
    Hold hold = holds.findLockedById(id).orElseThrow(() -> new NotFoundException("hold", id));
    hold.getProperty().getCode();
    hold.getRoomType().getCode();
    hold.getPriceLines().size();
    return hold;
  }

  /**
   * Reads the hold under a row lock that gives up after {@code booking.lock-timeout}. Release and
   * expiry use it, so they fail fast (or, for the sweep, skip the hold) while a confirmation holds
   * the row. The timeout is set for this transaction only.
   */
  private Hold lockedGetWithinTimeout(UUID id) {
    entities
        .createNativeQuery("select set_config('lock_timeout', :limit, true)")
        .setParameter("limit", config.lockTimeout().toMillis() + "ms")
        .getSingleResult();
    return lockedGet(id);
  }

  /** Releases the hold's rooms. Only an active hold can be released. */
  public Hold release(UUID id) {
    return retry.run(
        () ->
            tx.execute(
                status -> {
                  Hold hold = lockedGetWithinTimeout(id);
                  hold.markReleased();
                  holds.saveAndFlush(hold);
                  releaseNights(hold);
                  return hold;
                }));
  }

  /**
   * Turns a usable hold into a confirmed reservation and charges the quoted total. The charge key
   * is derived from the hold, so a retried confirmation charges once. A stay quoted at zero moves
   * no money: it is confirmed without a charge or a ledger entry.
   */
  public Reservation confirm(UUID id) {
    return retry.run(
        () ->
            tx.execute(
                status -> {
                  Hold hold = lockedGet(id);
                  Instant now = clock.instant();
                  hold.requireUsable(now);
                  if (hold.getStay()
                      .checkIn()
                      .isBefore(LocalDate.ofInstant(now, hold.getProperty().zone()))) {
                    // The stay has begun at the property: the hold is refused and left to expire.
                    throw new HoldExpiredException(id.toString());
                  }
                  boolean charged = hold.getTotal().isPositive();
                  String gatewayReference =
                      charged ? payments.charge("charge-" + id, hold.getTotal()) : null;
                  hold.markConfirmed();
                  holds.saveAndFlush(hold);
                  for (LocalDate night : hold.getStay().nightDates()) {
                    if (inventory.confirmHeld(hold.getRoomType().getId(), night, hold.getRooms())
                        == 0) {
                      throw outOfStep(hold, night);
                    }
                  }
                  Reservation reservation =
                      reservations.saveAndFlush(
                          new Reservation(ReferenceCode.generate(random), hold, now));
                  if (charged) {
                    ledger.save(
                        new LedgerEntry(
                            reservation.getId(),
                            LedgerKind.CHARGE,
                            hold.getTotal(),
                            "payment for hold " + id,
                            gatewayReference,
                            now));
                  }
                  return reservation;
                }));
  }

  /** Holds in one state, earliest expiry first; the admin view. */
  public Page<Hold> list(HoldStatus status, String propertyCode, Pageable page) {
    return holds.findForAdmin(status, propertyCode, page);
  }

  /** Active, confirmed, released and expired holds, zero for the states with none. */
  public Map<HoldStatus, Long> countByStatus() {
    var counts = new EnumMap<HoldStatus, Long>(HoldStatus.class);
    for (HoldStatus status : HoldStatus.values()) {
      counts.put(status, 0L);
    }
    for (HoldStatusCount row : holds.countByStatus()) {
      counts.put(row.getStatus(), row.getTotal());
    }
    return counts;
  }

  /**
   * Ops override: expires an active hold now, whatever its time limit says, and frees its rooms.
   */
  public Hold expireNow(UUID id) {
    return retry.run(
        () ->
            tx.execute(
                status -> {
                  Hold hold = lockedGetWithinTimeout(id);
                  if (hold.getStatus() != HoldStatus.ACTIVE) {
                    throw new ConflictException(
                        "hold " + id + " is " + hold.getStatus() + ", not active");
                  }
                  hold.markExpired();
                  holds.saveAndFlush(hold);
                  releaseNights(hold);
                  return hold;
                }));
  }

  /**
   * Expires every active hold whose time has passed, reading them {@code batchSize} at a time, and
   * returns how many this call expired. Each hold is its own unit of work, so one conflict does not
   * undo the others.
   */
  public int releaseExpired(int batchSize) {
    Instant now = clock.instant();
    int expired = 0;
    Instant afterExpiry = Instant.EPOCH;
    UUID afterId = new UUID(0L, 0L);
    List<Hold> due;
    do {
      due =
          holds.findDueAfter(
              HoldStatus.ACTIVE, now, afterExpiry, afterId, PageRequest.of(0, batchSize));
      for (Hold hold : due) {
        afterExpiry = hold.getExpiresAt();
        afterId = hold.getId();
        UUID id = afterId;
        try {
          expired += retry.run(() -> tx.execute(status -> expireOne(id, now)));
        } catch (PessimisticLockingFailureException
            | LockTimeoutException
            | PessimisticLockException e) {
          // A confirmation is deciding this hold. It is skipped for this run and, if still due,
          // found again by the next run.
        }
      }
    } while (due.size() == batchSize);
    return expired;
  }

  private int expireOne(UUID id, Instant now) {
    Hold hold = lockedGetWithinTimeout(id);
    if (hold.getStatus() != HoldStatus.ACTIVE || !hold.isExpiredAt(now)) {
      return 0;
    }
    hold.markExpired();
    holds.saveAndFlush(hold);
    releaseNights(hold);
    return 1;
  }

  private void releaseNights(Hold hold) {
    for (LocalDate night : hold.getStay().nightDates()) {
      if (inventory.releaseHeld(hold.getRoomType().getId(), night, hold.getRooms()) == 0) {
        throw outOfStep(hold, night);
      }
    }
  }

  private IllegalStateException outOfStep(Hold hold, LocalDate night) {
    return new IllegalStateException(
        "inventory for "
            + hold.getRoomType().getCode()
            + " on "
            + night
            + " does not cover the hold being changed");
  }
}
