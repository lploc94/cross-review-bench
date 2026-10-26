package com.innkeep.booking.domain;

import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZoneId;

/**
 * Refund tiers of one property. A cancellation at least {@code fullRefundDays} days before the
 * check-in date (in the property's zone, at its check-in time) refunds everything; before the
 * check-in moment it refunds the partial percentage; from check-in on, nothing. The deadlines are
 * computed as local date-times and converted with the zone rules, so they stay right across DST.
 */
public final class CancellationPolicy {

  private final ZoneId zone;
  private final LocalTime checkInTime;
  private final int fullRefundDays;
  private final int partialRefundPercent;

  private CancellationPolicy(
      ZoneId zone, LocalTime checkInTime, int fullRefundDays, int partialRefundPercent) {
    this.zone = zone;
    this.checkInTime = checkInTime;
    this.fullRefundDays = fullRefundDays;
    this.partialRefundPercent = partialRefundPercent;
  }

  public static CancellationPolicy of(Property property) {
    return new CancellationPolicy(
        property.zone(),
        property.getCheckInTime(),
        property.getFullRefundDays(),
        property.getPartialRefundPercent());
  }

  /** The instant from which only the partial refund applies. */
  public Instant fullRefundDeadline(LocalDate checkIn) {
    return checkIn.minusDays(fullRefundDays).atTime(checkInTime).atZone(zone).toInstant();
  }

  /** The instant the guest checks in; from here on nothing is refunded. */
  public Instant checkInMoment(LocalDate checkIn) {
    return checkIn.atTime(checkInTime).atZone(zone).toInstant();
  }

  public int refundPercent(LocalDate checkIn, Instant cancelledAt) {
    if (!cancelledAt.isAfter(fullRefundDeadline(checkIn))) {
      return 100;
    }
    if (cancelledAt.isBefore(checkInMoment(checkIn))) {
      return partialRefundPercent;
    }
    return 0;
  }

  public Money refund(Money paid, LocalDate checkIn, Instant cancelledAt) {
    return paid.percent(refundPercent(checkIn, cancelledAt));
  }
}
