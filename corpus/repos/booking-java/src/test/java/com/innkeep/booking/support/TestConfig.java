package com.innkeep.booking.support;

import java.time.Instant;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;

/** Replaces the clock and the payment gateway for every integration test. */
@TestConfiguration(proxyBeanMethods = false)
public class TestConfig {

  public static final Instant START = Instant.parse("2027-05-01T10:00:00Z");

  @Bean
  @Primary
  public MutableClock testClock() {
    return new MutableClock(START);
  }

  @Bean
  @Primary
  public RecordingPaymentGateway recordingPaymentGateway() {
    return new RecordingPaymentGateway();
  }
}
