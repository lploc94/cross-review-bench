package com.innkeep.booking.service;

import com.innkeep.booking.domain.Money;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The default gateway when a deployment provides none: it records the movement in the log and moves
 * no money. It logs keys and amounts only, never guest details.
 */
public class LoggingPaymentGateway implements PaymentGateway {

  private static final Logger log = LoggerFactory.getLogger(LoggingPaymentGateway.class);

  @Override
  public String charge(String idempotencyKey, Money amount) {
    log.info("payment charge amount={} {}", amount.amount(), amount.currency().getCurrencyCode());
    return "stub:" + idempotencyKey;
  }

  @Override
  public String refund(String idempotencyKey, Money amount) {
    log.info("payment refund amount={} {}", amount.amount(), amount.currency().getCurrencyCode());
    return "stub:" + idempotencyKey;
  }
}
