package com.innkeep.booking.domain;

import java.time.LocalDate;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.stream.Stream;

/**
 * A stay from a check-in date to a check-out date. It occupies the nights A … B−1, where each night
 * is a local date of the property; the check-out day itself is not a night.
 */
public record DateRange(LocalDate checkIn, LocalDate checkOut) {

  public DateRange {
    if (checkIn == null || checkOut == null) {
      throw new ValidationException("check-in and check-out dates are required");
    }
    if (!checkOut.isAfter(checkIn)) {
      throw new ValidationException("check-out must be after check-in");
    }
  }

  public long nights() {
    return ChronoUnit.DAYS.between(checkIn, checkOut);
  }

  public LocalDate lastNight() {
    return checkOut.minusDays(1);
  }

  /** The occupied nights in ascending order. Callers lock inventory in this order. */
  public List<LocalDate> nightDates() {
    return Stream.iterate(checkIn, d -> d.plusDays(1)).limit(nights()).toList();
  }

  public boolean includesNight(LocalDate night) {
    return !night.isBefore(checkIn) && night.isBefore(checkOut);
  }
}
