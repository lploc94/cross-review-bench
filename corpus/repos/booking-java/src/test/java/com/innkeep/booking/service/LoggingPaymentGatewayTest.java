package com.innkeep.booking.service;

import static org.assertj.core.api.Assertions.assertThat;

import com.innkeep.booking.domain.Money;
import com.innkeep.booking.support.LogCapture;
import java.math.BigDecimal;
import java.util.Currency;
import org.junit.jupiter.api.Test;

class LoggingPaymentGatewayTest {

  @Test
  void theLogNamesTheAmountButNotTheIdempotencyKeys() throws Exception {
    var gateway = new LoggingPaymentGateway();
    var amount = Money.of(new BigDecimal("100.00"), Currency.getInstance("EUR"));

    String logged =
        LogCapture.during(
            LoggingPaymentGateway.class.getName(),
            () -> {
              gateway.charge("charge-SECRET-HOLD-KEY", amount);
              gateway.refund("refund-SECRET-RESERVATION-KEY", amount);
            });

    assertThat(logged).contains("100.00").doesNotContain("SECRET");
  }
}
