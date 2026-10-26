package com.innkeep.booking.api.dto;

import com.innkeep.booking.domain.Quote;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.List;

public record QuoteResponse(
    String roomType,
    LocalDate checkIn,
    LocalDate checkOut,
    int rooms,
    int guests,
    String currency,
    BigDecimal total,
    List<PriceLineResponse> lines) {

  public static QuoteResponse from(Quote quote) {
    return new QuoteResponse(
        quote.roomTypeCode(),
        quote.stay().checkIn(),
        quote.stay().checkOut(),
        quote.rooms(),
        quote.guests(),
        quote.total().currency().getCurrencyCode(),
        quote.total().amount(),
        PriceLineResponse.fromAll(quote.lines()));
  }
}
