package com.innkeep.booking.api.dto;

import com.innkeep.booking.domain.Hold;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.util.UUID;

/** A hold as the admin list shows it. */
public record HoldSummary(
    UUID id,
    String status,
    String propertyCode,
    String roomTypeCode,
    LocalDate checkIn,
    LocalDate checkOut,
    int rooms,
    int guests,
    BigDecimal total,
    String currency,
    Instant expiresAt) {

  public static HoldSummary from(Hold hold) {
    return new HoldSummary(
        hold.getId(),
        hold.getStatus().name(),
        hold.getProperty().getCode(),
        hold.getRoomType().getCode(),
        hold.getStay().checkIn(),
        hold.getStay().checkOut(),
        hold.getRooms(),
        hold.getGuests(),
        hold.getTotal().amount(),
        hold.getTotal().currency().getCurrencyCode(),
        hold.getExpiresAt());
  }
}
