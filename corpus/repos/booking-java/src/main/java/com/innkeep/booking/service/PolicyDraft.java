package com.innkeep.booking.service;

/** The refund and pricing rules of a property, as an admin sets them. */
public record PolicyDraft(
    int fullRefundDays,
    int partialRefundPercent,
    int weekendSurchargePercent,
    int losMinNights,
    int losDiscountPercent) {}
