package com.innkeep.booking.support;

import com.innkeep.booking.domain.DateRange;
import com.innkeep.booking.domain.GuestDetails;
import com.innkeep.booking.domain.Hold;
import com.innkeep.booking.domain.PricingEngine;
import com.innkeep.booking.domain.Property;
import com.innkeep.booking.domain.Quote;
import com.innkeep.booking.domain.RoomType;
import java.math.BigDecimal;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalTime;
import java.time.ZoneId;
import java.util.Currency;
import java.util.List;

/** Entities built in memory, for the unit tests that need no database. */
public final class Fixtures {

  private Fixtures() {}

  public static Property property(String zone, int weekendPercent, int losPercent) {
    return new Property(
        "harbour-house",
        "Invented Harbour House",
        ZoneId.of(zone),
        LocalTime.of(15, 0),
        LocalTime.of(11, 0),
        Currency.getInstance("EUR"),
        7,
        50,
        weekendPercent,
        7,
        losPercent);
  }

  public static RoomType roomType(Property property, int capacity, String rate) {
    return new RoomType(
        property, "double", "Double room", capacity, new BigDecimal(rate), new BigDecimal("15.00"));
  }

  public static Quote quote(
      Property property, RoomType type, DateRange stay, int rooms, int guests) {
    return PricingEngine.quote(property, type, List.of(), stay, rooms, guests);
  }

  public static Hold hold(Property property, RoomType type, DateRange stay, Instant createdAt) {
    return new Hold(
        property,
        type,
        stay,
        1,
        2,
        new GuestDetails("Mara Quill", "guest@example.com", null),
        quote(property, type, stay, 1, 2),
        createdAt,
        Duration.ofMinutes(15));
  }
}
