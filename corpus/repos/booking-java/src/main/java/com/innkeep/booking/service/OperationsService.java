package com.innkeep.booking.service;

import com.innkeep.booking.domain.DateRange;
import com.innkeep.booking.domain.Inventory;
import com.innkeep.booking.domain.LedgerKind;
import com.innkeep.booking.domain.Property;
import com.innkeep.booking.domain.Reservation;
import com.innkeep.booking.domain.ValidationException;
import com.innkeep.booking.persistence.InventoryRepository;
import com.innkeep.booking.persistence.KindTotal;
import com.innkeep.booking.persistence.LedgerEntryRepository;
import com.innkeep.booking.persistence.ReservationRepository;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import org.springframework.stereotype.Service;

/** Day-level views for the front desk and the owner: occupancy, arrivals and departures. */
@Service
public class OperationsService {

  private static final int MAX_NIGHTS = 366;

  private final CatalogService catalog;
  private final InventoryRepository inventory;
  private final ReservationRepository reservations;
  private final LedgerEntryRepository ledger;

  public OperationsService(
      CatalogService catalog,
      InventoryRepository inventory,
      ReservationRepository reservations,
      LedgerEntryRepository ledger) {
    this.catalog = catalog;
    this.inventory = inventory;
    this.reservations = reservations;
    this.ledger = ledger;
  }

  /**
   * Per night across every room type of the property. A night with no inventory rows reports zero
   * rooms, and occupancy is the share of set rooms that are held or booked, one decimal, HALF_EVEN.
   */
  public List<OccupancyDay> occupancy(String propertyCode, DateRange range) {
    catalog.property(propertyCode);
    if (range.nights() > MAX_NIGHTS) {
      throw new ValidationException("at most " + MAX_NIGHTS + " nights at a time");
    }
    var sums = new HashMap<LocalDate, Counts>();
    for (Inventory row :
        inventory.findForProperty(propertyCode, range.checkIn(), range.lastNight())) {
      sums.merge(
          row.getNight(), new Counts(row.getTotal(), row.getHeld(), row.getBooked()), Counts::plus);
    }
    var days = new ArrayList<OccupancyDay>();
    for (LocalDate night : range.nightDates()) {
      Counts counts = sums.getOrDefault(night, Counts.NONE);
      days.add(
          new OccupancyDay(
              night, counts.total(), counts.held(), counts.booked(), percentInUse(counts)));
    }
    return days;
  }

  /** Confirmed reservations that check in on {@code day}, by reservation id. */
  public List<Reservation> arrivals(String propertyCode, LocalDate day) {
    catalog.property(propertyCode);
    return reservations.findArrivals(propertyCode, day);
  }

  /** Checked-in reservations that check out on {@code day}, by reservation id. */
  public List<Reservation> departures(String propertyCode, LocalDate day) {
    catalog.property(propertyCode);
    return reservations.findDepartures(propertyCode, day);
  }

  private static BigDecimal percentInUse(Counts counts) {
    if (counts.total() == 0) {
      return BigDecimal.ZERO.setScale(1, RoundingMode.HALF_EVEN);
    }
    return BigDecimal.valueOf(counts.held() + counts.booked())
        .multiply(BigDecimal.valueOf(100))
        .divide(BigDecimal.valueOf(counts.total()), 1, RoundingMode.HALF_EVEN);
  }

  private record Counts(int total, int held, int booked) {

    static final Counts NONE = new Counts(0, 0, 0);

    Counts plus(Counts other) {
      return new Counts(total + other.total, held + other.held, booked + other.booked);
    }
  }

  /**
   * Checked-in reservations staying the night of {@code day} (checked in on or before it, checking
   * out after it), by room type code and then reservation id.
   */
  public List<Reservation> inHouse(String propertyCode, LocalDate day) {
    catalog.property(propertyCode);
    return reservations.findInHouse(propertyCode, day);
  }

  /**
   * Net money for the period: charges minus refunds of ledger entries created between midnight at
   * the start and midnight at the end of the period, in the property's own time zone.
   */
  public NetRevenue netRevenue(String propertyCode, DateRange period) {
    Property property = catalog.property(propertyCode);
    int digits = property.currency().getDefaultFractionDigits();
    Instant from = period.checkIn().atStartOfDay(property.zone()).toInstant();
    Instant to = period.checkOut().atStartOfDay(property.zone()).toInstant();
    BigDecimal charged = BigDecimal.ZERO.setScale(digits);
    BigDecimal refunded = BigDecimal.ZERO.setScale(digits);
    for (KindTotal row : ledger.totalsByKind(propertyCode, from, to)) {
      if (row.getKind() == LedgerKind.CHARGE) {
        charged = row.getTotal().setScale(digits, RoundingMode.HALF_EVEN);
      } else {
        refunded = row.getTotal().setScale(digits, RoundingMode.HALF_EVEN);
      }
    }
    return new NetRevenue(
        period.checkIn(),
        period.checkOut(),
        property.currency().getCurrencyCode(),
        charged,
        refunded,
        charged.subtract(refunded));
  }
}
