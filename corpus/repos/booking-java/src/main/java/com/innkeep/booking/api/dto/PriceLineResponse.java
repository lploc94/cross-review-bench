package com.innkeep.booking.api.dto;

import com.innkeep.booking.domain.PriceLine;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.List;

public record PriceLineResponse(
    String kind, LocalDate night, String description, BigDecimal amount) {

  public static PriceLineResponse from(PriceLine line) {
    return new PriceLineResponse(
        line.getKind().name(), line.getNight(), line.getDescription(), line.getAmount());
  }

  public static List<PriceLineResponse> fromAll(List<PriceLine> lines) {
    return lines.stream().map(PriceLineResponse::from).toList();
  }
}
