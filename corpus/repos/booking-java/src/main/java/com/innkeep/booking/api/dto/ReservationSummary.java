package com.innkeep.booking.api.dto;

import com.innkeep.booking.domain.Reservation;
import java.math.BigDecimal;
import java.time.LocalDate;

/** A reservation as it appears in a list: without its price breakdown. */
public record ReservationSummary(
    String reference,
    String status,
    String propertyCode,
    String roomType,
    LocalDate checkIn,
    LocalDate checkOut,
    int rooms,
    int guests,
    String guestName,
    String guestEmail,
    String currency,
    BigDecimal total) {

  public static ReservationSummary from(Reservation reservation) {
    return new ReservationSummary(
        reservation.getReference(),
        reservation.getStatus().name(),
        reservation.getProperty().getCode(),
        reservation.getRoomType().getCode(),
        reservation.getCheckIn(),
        reservation.getCheckOut(),
        reservation.getRooms(),
        reservation.getGuests(),
        reservation.getGuest().getName(),
        reservation.getGuest().getEmail(),
        reservation.getTotal().currency().getCurrencyCode(),
        reservation.getTotal().amount());
  }
}
