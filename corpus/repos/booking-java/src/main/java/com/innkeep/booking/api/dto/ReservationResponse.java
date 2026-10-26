package com.innkeep.booking.api.dto;

import com.fasterxml.jackson.annotation.JsonUnwrapped;
import com.innkeep.booking.domain.Reservation;
import java.time.Instant;
import java.util.List;

/** A reservation with the price breakdown it was booked with and its timestamps. */
public record ReservationResponse(
    @JsonUnwrapped ReservationSummary summary,
    List<PriceLineResponse> lines,
    Instant createdAt,
    Instant updatedAt,
    Instant cancelledAt) {

  public static ReservationResponse from(Reservation reservation) {
    return new ReservationResponse(
        ReservationSummary.from(reservation),
        PriceLineResponse.fromAll(reservation.getPriceLines()),
        reservation.getCreatedAt(),
        reservation.getUpdatedAt(),
        reservation.getCancelledAt());
  }
}
