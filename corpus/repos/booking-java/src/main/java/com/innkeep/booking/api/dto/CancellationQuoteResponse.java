package com.innkeep.booking.api.dto;

import com.innkeep.booking.service.CancellationQuote;
import java.math.BigDecimal;
import java.time.Instant;

/** What cancelling at {@code at} would refund; nothing is cancelled by asking. */
public record CancellationQuoteResponse(
    Instant at, int refundPercent, BigDecimal refundAmount, String currency) {

  public static CancellationQuoteResponse from(CancellationQuote quote) {
    return new CancellationQuoteResponse(
        quote.at(),
        quote.refundPercent(),
        quote.refund().amount(),
        quote.refund().currency().getCurrencyCode());
  }
}
