package com.innkeep.booking.api.dto;

import com.innkeep.booking.service.SeasonalRateDraft;
import jakarta.validation.constraints.NotNull;
import java.math.BigDecimal;
import java.time.LocalDate;

public record SeasonalRateRequest(
    @NotNull LocalDate startDate,
    @NotNull LocalDate endDate,
    @NotNull BigDecimal nightlyRate,
    int priority) {

  public SeasonalRateDraft toDraft() {
    return new SeasonalRateDraft(startDate, endDate, nightlyRate, priority);
  }
}
