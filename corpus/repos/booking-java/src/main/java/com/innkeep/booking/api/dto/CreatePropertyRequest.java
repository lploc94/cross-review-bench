package com.innkeep.booking.api.dto;

import com.innkeep.booking.service.PropertyDraft;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import java.time.LocalTime;

public record CreatePropertyRequest(
    @NotBlank String code,
    @NotBlank String name,
    @NotBlank String timeZone,
    @NotNull LocalTime checkInTime,
    @NotNull LocalTime checkOutTime,
    @NotBlank String currency,
    @NotNull PolicyRequest policy) {

  public PropertyDraft toDraft() {
    return new PropertyDraft(
        code,
        name,
        timeZone,
        checkInTime,
        checkOutTime,
        currency,
        policy.fullRefundDays(),
        policy.partialRefundPercent(),
        policy.weekendSurchargePercent(),
        policy.losMinNights(),
        policy.losDiscountPercent());
  }
}
