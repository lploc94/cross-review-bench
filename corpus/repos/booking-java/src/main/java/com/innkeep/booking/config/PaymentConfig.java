package com.innkeep.booking.config;

import com.innkeep.booking.service.LoggingPaymentGateway;
import com.innkeep.booking.service.PaymentGateway;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/** Provides the default payment gateway. A deployment replaces it by declaring its own bean. */
@Configuration
public class PaymentConfig {

  @Bean
  @ConditionalOnMissingBean(PaymentGateway.class)
  public PaymentGateway paymentGateway() {
    return new LoggingPaymentGateway();
  }
}
