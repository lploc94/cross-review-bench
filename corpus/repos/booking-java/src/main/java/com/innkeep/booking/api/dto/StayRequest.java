package com.innkeep.booking.api.dto;

import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import java.time.LocalDate;

/** What a guest asks for: a room type, a date range, the number of rooms and of guests. */
public record StayRequest(
    @NotBlank String roomType,
    @NotNull LocalDate checkIn,
    @NotNull LocalDate checkOut,
    @Min(1) int rooms,
    @Min(1) int guests) {}
