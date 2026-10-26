package com.innkeep.booking.api.dto;

import com.innkeep.booking.service.RoomTypeDraft;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import java.math.BigDecimal;

public record CreateRoomTypeRequest(
    @NotBlank String code,
    @NotBlank String name,
    int capacity,
    @NotNull BigDecimal baseNightlyRate,
    @NotNull BigDecimal extraGuestFee) {

  public RoomTypeDraft toDraft() {
    return new RoomTypeDraft(code, name, capacity, baseNightlyRate, extraGuestFee);
  }
}
