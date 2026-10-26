package com.innkeep.booking.service;

import com.innkeep.booking.domain.Money;

/**
 * Charges and refunds through the payment provider. Both calls take an idempotency key derived from
 * the business action, so a retried unit of work never moves money twice. Implementations return
 * the provider's reference for the movement.
 */
public interface PaymentGateway {

  String charge(String idempotencyKey, Money amount);

  String refund(String idempotencyKey, Money amount);
}
