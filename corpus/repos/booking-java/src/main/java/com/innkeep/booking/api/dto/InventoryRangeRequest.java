package com.innkeep.booking.api.dto;

import com.innkeep.booking.domain.DateRange;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotNull;
import java.time.LocalDate;

/** One total for every night from {@code from} up to {@code to} (check-out, exclusive). */
public record InventoryRangeRequest(
    @NotNull LocalDate from, @NotNull LocalDate to, @Min(0) int total) {

  public DateRange range() {
    return new DateRange(from, to);
  }
}
