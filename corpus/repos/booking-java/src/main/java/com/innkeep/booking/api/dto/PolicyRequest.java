package com.innkeep.booking.api.dto;

import com.innkeep.booking.service.PolicyDraft;

/** Refund and pricing rules of a property; the catalog service checks the ranges. */
public record PolicyRequest(
    int fullRefundDays,
    int partialRefundPercent,
    int weekendSurchargePercent,
    int losMinNights,
    int losDiscountPercent) {

  public PolicyDraft toDraft() {
    return new PolicyDraft(
        fullRefundDays,
        partialRefundPercent,
        weekendSurchargePercent,
        losMinNights,
        losDiscountPercent);
  }
}
