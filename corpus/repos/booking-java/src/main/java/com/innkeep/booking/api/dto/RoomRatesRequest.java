package com.innkeep.booking.api.dto;

import jakarta.validation.constraints.NotNull;
import java.math.BigDecimal;

/** New base rate and extra-guest fee; quotes already made keep their price lines. */
public record RoomRatesRequest(
    @NotNull BigDecimal baseNightlyRate, @NotNull BigDecimal extraGuestFee) {}
