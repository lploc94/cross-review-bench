package com.innkeep.booking.config;

import com.innkeep.booking.domain.DateRange;
import com.innkeep.booking.domain.ValidationException;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import java.time.Duration;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;
import org.springframework.validation.annotation.Validated;

/**
 * Typed settings under the {@code booking} prefix. The application refuses to start when a value is
 * out of range, so a bad deployment fails at boot rather than on the first guest request.
 */
@Validated
@ConfigurationProperties(prefix = "booking")
public record BookingConfig(
    @NotBlank String adminToken,
    @DefaultValue("PT15M") Duration holdTtl,
    @DefaultValue("200") @Min(1) @Max(1000) int holdCleanupBatchSize,
    @DefaultValue("PT1M") Duration holdCleanupInterval,
    @DefaultValue("10") @Min(1) @Max(50) int maxRoomsPerBooking,
    @DefaultValue("60") @Min(1) @Max(365) int maxNightsPerStay,
    @DefaultValue("3") @Min(1) @Max(10) int maxRetryAttempts,
    @DefaultValue("true") boolean schedulingEnabled,
    @DefaultValue("PT3S") Duration lockTimeout) {

  private static final Duration MAX_HOLD_TTL = Duration.ofDays(1);
  private static final Duration MAX_LOCK_TIMEOUT = Duration.ofSeconds(30);

  public BookingConfig {
    if (holdTtl == null || holdTtl.isZero() || holdTtl.isNegative()) {
      throw new IllegalArgumentException("booking.hold-ttl must be positive");
    }
    if (holdTtl.compareTo(MAX_HOLD_TTL) > 0) {
      throw new IllegalArgumentException("booking.hold-ttl must not exceed one day");
    }
    if (lockTimeout == null
        || lockTimeout.compareTo(Duration.ofMillis(1)) < 0
        || lockTimeout.compareTo(MAX_LOCK_TIMEOUT) > 0) {
      throw new IllegalArgumentException("booking.lock-timeout must be between 1 ms and 30 s");
    }
    if (holdCleanupInterval == null
        || holdCleanupInterval.isZero()
        || holdCleanupInterval.isNegative()) {
      throw new IllegalArgumentException("booking.hold-cleanup-interval must be positive");
    }
  }

  /** Rejects stays and room counts above the configured maximums. */
  public void requireWithinLimits(DateRange stay, int rooms) {
    if (rooms < 1 || rooms > maxRoomsPerBooking) {
      throw new ValidationException("rooms must be between 1 and " + maxRoomsPerBooking);
    }
    if (stay.nights() > maxNightsPerStay) {
      throw new ValidationException("a stay may not exceed " + maxNightsPerStay + " nights");
    }
  }
}
