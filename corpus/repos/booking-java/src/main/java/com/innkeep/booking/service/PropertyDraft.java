package com.innkeep.booking.service;

import java.time.LocalTime;

/** The terms a new guest house is created with, before validation. */
public record PropertyDraft(
    String code,
    String name,
    String timeZone,
    LocalTime checkInTime,
    LocalTime checkOutTime,
    String currency,
    int fullRefundDays,
    int partialRefundPercent,
    int weekendSurchargePercent,
    int losMinNights,
    int losDiscountPercent) {}
