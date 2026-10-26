package com.innkeep.booking.api.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import java.time.LocalTime;

public record PropertyDetailsRequest(
    @NotBlank String name,
    @NotBlank String timeZone,
    @NotNull LocalTime checkInTime,
    @NotNull LocalTime checkOutTime) {}
