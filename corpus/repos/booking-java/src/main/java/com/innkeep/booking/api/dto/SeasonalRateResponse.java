package com.innkeep.booking.api.dto;

import com.innkeep.booking.domain.SeasonalRate;
import java.math.BigDecimal;
import java.time.LocalDate;

public record SeasonalRateResponse(
    long id, LocalDate startDate, LocalDate endDate, BigDecimal nightlyRate, int priority) {

  public static SeasonalRateResponse from(SeasonalRate rate) {
    return new SeasonalRateResponse(
        rate.getId(),
        rate.getStartDate(),
        rate.getEndDate(),
        rate.getNightlyRate(),
        rate.getPriority());
  }
}
