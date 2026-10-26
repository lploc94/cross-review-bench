package com.innkeep.booking.api.dto;

import com.innkeep.booking.domain.Hold;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;

public record HoldResponse(
    UUID id,
    String status,
    String propertyCode,
    String roomType,
    LocalDate checkIn,
    LocalDate checkOut,
    int rooms,
    int guests,
    String currency,
    BigDecimal total,
    Instant expiresAt,
    List<PriceLineResponse> lines) {

  public static HoldResponse from(Hold hold) {
    return new HoldResponse(
        hold.getId(),
        hold.getStatus().name(),
        hold.getProperty().getCode(),
        hold.getRoomType().getCode(),
        hold.getStay().checkIn(),
        hold.getStay().checkOut(),
        hold.getRooms(),
        hold.getGuests(),
        hold.getTotal().currency().getCurrencyCode(),
        hold.getTotal().amount(),
        hold.getExpiresAt(),
        PriceLineResponse.fromAll(hold.getPriceLines()));
  }
}
