package com.innkeep.booking.support;

import com.innkeep.booking.domain.DateRange;
import com.innkeep.booking.domain.GuestDetails;
import com.innkeep.booking.domain.Hold;
import com.innkeep.booking.domain.Property;
import com.innkeep.booking.domain.Reservation;
import com.innkeep.booking.domain.RoomType;
import com.innkeep.booking.domain.SeasonalRate;
import com.innkeep.booking.persistence.PropertyRepository;
import com.innkeep.booking.persistence.RoomTypeRepository;
import com.innkeep.booking.persistence.SeasonalRateRepository;
import com.innkeep.booking.service.CatalogService;
import com.innkeep.booking.service.HoldService;
import com.innkeep.booking.service.NightTotal;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZoneId;
import java.util.Currency;
import java.util.stream.Stream;
import org.springframework.stereotype.Component;

/**
 * Builds invented guest houses, room types, rates and bookings for the tests. Every name, guest and
 * address here is invented: guests are example.com addresses, the property is "Harbour House" or
 * similar.
 */
@Component
public class TestData {

  public static final ZoneId LISBON = ZoneId.of("Europe/Lisbon");
  public static final String GUEST_EMAIL = "guest@example.com";

  private final PropertyRepository properties;
  private final RoomTypeRepository roomTypes;
  private final SeasonalRateRepository seasonalRates;
  private final CatalogService catalog;
  private final HoldService holds;

  public TestData(
      PropertyRepository properties,
      RoomTypeRepository roomTypes,
      SeasonalRateRepository seasonalRates,
      CatalogService catalog,
      HoldService holds) {
    this.properties = properties;
    this.roomTypes = roomTypes;
    this.seasonalRates = seasonalRates;
    this.catalog = catalog;
    this.holds = holds;
  }

  /** A Lisbon property with the standard refund, weekend and length-of-stay terms. */
  public Property harbourHouse() {
    return property("harbour-house", LISBON.getId(), 10, 0);
  }

  public Property property(String code, String zone, int weekendPercent, int losPercent) {
    return properties.save(
        new Property(
            code,
            "Invented " + code,
            ZoneId.of(zone),
            LocalTime.of(15, 0),
            LocalTime.of(11, 0),
            Currency.getInstance("EUR"),
            7,
            50,
            weekendPercent,
            7,
            losPercent));
  }

  public RoomType roomType(Property property, String code, int capacity, String rate) {
    return roomTypes.save(
        new RoomType(
            property,
            code,
            "Room " + code,
            capacity,
            new BigDecimal(rate),
            new BigDecimal("15.00")));
  }

  public SeasonalRate seasonal(
      RoomType type, LocalDate from, LocalDate to, String rate, int priority) {
    return seasonalRates.save(new SeasonalRate(type, from, to, new BigDecimal(rate), priority));
  }

  /** Sets the sellable total for every night of the range (end exclusive). */
  public void rooms(Property property, RoomType type, LocalDate from, LocalDate to, int total) {
    var nights =
        Stream.iterate(from, d -> d.plusDays(1))
            .limit(new DateRange(from, to).nights())
            .map(night -> new NightTotal(night, total))
            .toList();
    catalog.setInventory(property.getCode(), type.getCode(), nights);
  }

  public Hold hold(Property property, RoomType type, LocalDate in, LocalDate out, int rooms) {
    return holds.create(
        property.getCode(),
        type.getCode(),
        new DateRange(in, out),
        rooms,
        rooms * type.getCapacity(),
        new GuestDetails("Mara Quill", GUEST_EMAIL, "+351 000 000 000"));
  }

  public Reservation book(
      Property property, RoomType type, LocalDate in, LocalDate out, int rooms) {
    return holds.confirm(hold(property, type, in, out, rooms).getId());
  }
}
