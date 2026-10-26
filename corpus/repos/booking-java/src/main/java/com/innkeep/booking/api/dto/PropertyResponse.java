package com.innkeep.booking.api.dto;

import com.innkeep.booking.domain.Property;
import java.time.LocalTime;

public record PropertyResponse(
    String code,
    String name,
    String timeZone,
    LocalTime checkInTime,
    LocalTime checkOutTime,
    String currency,
    int fullRefundDays,
    int partialRefundPercent,
    int weekendSurchargePercent,
    int losMinNights,
    int losDiscountPercent) {

  public static PropertyResponse from(Property property) {
    return new PropertyResponse(
        property.getCode(),
        property.getName(),
        property.zone().getId(),
        property.getCheckInTime(),
        property.getCheckOutTime(),
        property.currency().getCurrencyCode(),
        property.getFullRefundDays(),
        property.getPartialRefundPercent(),
        property.getWeekendSurchargePercent(),
        property.getLosMinNights(),
        property.getLosDiscountPercent());
  }
}
