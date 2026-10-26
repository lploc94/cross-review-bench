package com.innkeep.booking.service;

import java.math.BigDecimal;
import java.time.LocalDate;

public record SeasonalRateDraft(
    LocalDate startDate, LocalDate endDate, BigDecimal nightlyRate, int priority) {}
