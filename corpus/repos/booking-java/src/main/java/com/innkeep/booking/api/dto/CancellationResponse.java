package com.innkeep.booking.api.dto;

import com.innkeep.booking.service.CancellationOutcome;
import java.math.BigDecimal;

public record CancellationResponse(
    ReservationResponse reservation, BigDecimal refundAmount, String currency) {

  public static CancellationResponse from(CancellationOutcome outcome) {
    return new CancellationResponse(
        ReservationResponse.from(outcome.reservation()),
        outcome.refund().amount(),
        outcome.refund().currency().getCurrencyCode());
  }
}
