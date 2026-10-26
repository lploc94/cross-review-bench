package com.papertrail.workflow.config;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Duration;
import java.time.LocalTime;
import java.time.ZoneId;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

class WorkflowConfigTest {

  private static WorkflowConfig properties(
      LocalTime start, LocalTime end, Duration retryBase, Duration jobInterval) {
    return new WorkflowConfig(
        "test-admin-token-0123456789",
        ZoneId.of("Europe/London"),
        start,
        end,
        50,
        5,
        retryBase,
        20,
        jobInterval,
        true);
  }

  @Test
  void validSettingsAreAccepted() {
    WorkflowConfig settings =
        properties(
            LocalTime.of(9, 0), LocalTime.of(17, 0), Duration.ofSeconds(30), Duration.ofMinutes(1));

    assertThat(settings.workingEnd()).isEqualTo(LocalTime.of(17, 0));
  }

  @Test
  void theWorkingDayMustEndAfterItStarts() {
    assertThatThrownBy(
            () ->
                properties(
                    LocalTime.of(17, 0),
                    LocalTime.of(9, 0),
                    Duration.ofSeconds(30),
                    Duration.ofMinutes(1)))
        .isInstanceOf(IllegalArgumentException.class);
  }

  @ParameterizedTest
  @ValueSource(strings = {"PT0S", "PT-1S", "PT11M"})
  void theRetryBaseIsBetweenZeroAndTenMinutes(String retryBase) {
    assertThatThrownBy(
            () ->
                properties(
                    LocalTime.of(9, 0),
                    LocalTime.of(17, 0),
                    Duration.parse(retryBase),
                    Duration.ofMinutes(1)))
        .isInstanceOf(IllegalArgumentException.class);
  }

  @Test
  void theJobIntervalMustBePositive() {
    assertThatThrownBy(
            () ->
                properties(
                    LocalTime.of(9, 0), LocalTime.of(17, 0), Duration.ofSeconds(30), Duration.ZERO))
        .isInstanceOf(IllegalArgumentException.class);
  }
}
