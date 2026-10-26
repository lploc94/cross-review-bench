package com.innkeep.booking.api.dto;

import com.innkeep.booking.domain.RoomType;
import java.math.BigDecimal;

public record RoomTypeResponse(
    String code,
    String name,
    int capacity,
    BigDecimal baseNightlyRate,
    BigDecimal extraGuestFee,
    String currency) {

  public static RoomTypeResponse from(RoomType type) {
    return new RoomTypeResponse(
        type.getCode(),
        type.getName(),
        type.getCapacity(),
        type.getBaseNightlyRate(),
        type.getExtraGuestFee(),
        type.getProperty().currency().getCurrencyCode());
  }
}
