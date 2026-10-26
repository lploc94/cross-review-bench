package com.papertrail.workflow.support;

import java.time.Instant;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;

/** Replaces the clock and the notifier for every integration test. */
@TestConfiguration(proxyBeanMethods = false)
public class TestConfig {

  /** A Monday: 11:00 in London, inside working hours. */
  public static final Instant START = Instant.parse("2027-05-03T10:00:00Z");

  @Bean
  @Primary
  public MutableClock testClock() {
    return new MutableClock(START);
  }

  @Bean
  @Primary
  public RecordingNotifier recordingNotifier() {
    return new RecordingNotifier();
  }
}
