package com.innkeep.booking.api.dto;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotNull;

public record HoldRequest(@NotNull @Valid StayRequest stay, @NotNull @Valid GuestRequest guest) {}
