package com.innkeep.booking.api.dto;

import com.innkeep.booking.service.AvailabilityRow;
import java.math.BigDecimal;

public record AvailabilityResponse(
    String roomType, String name, int availableRooms, BigDecimal total, String currency) {

  public static AvailabilityResponse from(AvailabilityRow row) {
    return new AvailabilityResponse(
        row.roomTypeCode(),
        row.roomTypeName(),
        row.availableRooms(),
        row.quotedTotal().amount(),
        row.quotedTotal().currency().getCurrencyCode());
  }
}
