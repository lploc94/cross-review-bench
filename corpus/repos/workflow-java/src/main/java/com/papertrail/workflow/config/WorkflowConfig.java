package com.papertrail.workflow.config;

import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import java.time.Duration;
import java.time.LocalTime;
import java.time.ZoneId;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;
import org.springframework.validation.annotation.Validated;

/**
 * Typed settings under the {@code workflow} prefix. The application refuses to start when a value
 * is out of range, so a bad deployment fails at boot rather than on the first request.
 */
@Validated
@ConfigurationProperties(prefix = "workflow")
public record WorkflowConfig(
    @NotBlank @Size(min = 16) String adminToken,
    @DefaultValue("Europe/London") ZoneId businessZone,
    @DefaultValue("09:00") LocalTime workingStart,
    @DefaultValue("17:00") LocalTime workingEnd,
    @DefaultValue("50") @Min(1) @Max(1000) int outboxBatchSize,
    @DefaultValue("5") @Min(1) @Max(20) int outboxMaxAttempts,
    @DefaultValue("PT30S") Duration outboxRetryBase,
    @DefaultValue("20") @Min(1) @Max(200) int escalationBatchSize,
    @DefaultValue("PT1M") Duration jobInterval,
    @DefaultValue("true") boolean schedulingEnabled) {

  private static final Duration MAX_RETRY_BASE = Duration.ofMinutes(10);

  public WorkflowConfig {
    if (businessZone == null) {
      throw new IllegalArgumentException("workflow.business-zone is required");
    }
    if (workingStart == null || workingEnd == null || !workingEnd.isAfter(workingStart)) {
      throw new IllegalArgumentException("workflow.working-end must be after working-start");
    }
    if (outboxRetryBase == null
        || outboxRetryBase.isNegative()
        || outboxRetryBase.isZero()
        || outboxRetryBase.compareTo(MAX_RETRY_BASE) > 0) {
      throw new IllegalArgumentException("workflow.outbox-retry-base must be between 0 and 10 min");
    }
    if (jobInterval == null || jobInterval.isNegative() || jobInterval.isZero()) {
      throw new IllegalArgumentException("workflow.job-interval must be positive");
    }
  }
}
