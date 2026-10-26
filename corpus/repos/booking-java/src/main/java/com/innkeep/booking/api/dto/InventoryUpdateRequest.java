package com.innkeep.booking.api.dto;

import com.innkeep.booking.service.NightTotal;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.NotNull;
import java.time.LocalDate;
import java.util.List;

public record InventoryUpdateRequest(@NotEmpty List<@Valid @NotNull NightRequest> nights) {

  public record NightRequest(@NotNull LocalDate date, @Min(0) int total) {}

  public List<NightTotal> toNightTotals() {
    return nights.stream().map(n -> new NightTotal(n.date(), n.total())).toList();
  }
}
