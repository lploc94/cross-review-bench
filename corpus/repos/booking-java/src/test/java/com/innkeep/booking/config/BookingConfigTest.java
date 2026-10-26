package com.innkeep.booking.config;

import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.innkeep.booking.domain.DateRange;
import com.innkeep.booking.domain.ValidationException;
import java.time.Duration;
import java.time.LocalDate;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

class BookingConfigTest {

  private static BookingConfig config(Duration holdTtl) {
    return new BookingConfig(
        "token", holdTtl, 200, Duration.ofMinutes(1), 10, 60, 3, true, Duration.ofSeconds(3));
  }

  @ParameterizedTest
  @ValueSource(strings = {"PT0S", "PT-1M"})
  void holdTtlMustBePositive(String ttl) {
    assertThatThrownBy(() -> config(Duration.parse(ttl)))
        .isInstanceOf(IllegalArgumentException.class)
        .hasMessageContaining("hold-ttl");
  }

  @Test
  void holdTtlMayNotExceedADay() {
    assertThatThrownBy(() -> config(Duration.ofDays(1).plusSeconds(1)))
        .isInstanceOf(IllegalArgumentException.class);
    assertThatCode(() -> config(Duration.ofDays(1))).doesNotThrowAnyException();
  }

  @ParameterizedTest
  @ValueSource(strings = {"PT0S", "PT-1S", "PT0.0005S", "PT31S"})
  void lockTimeoutMustBeBetweenOneMillisecondAndThirtySeconds(String timeout) {
    assertThatThrownBy(
            () ->
                new BookingConfig(
                    "token",
                    Duration.ofMinutes(15),
                    200,
                    Duration.ofMinutes(1),
                    10,
                    60,
                    3,
                    true,
                    Duration.parse(timeout)))
        .isInstanceOf(IllegalArgumentException.class)
        .hasMessageContaining("lock-timeout");
  }

  @Test
  void roomsAndNightsAtTheLimitAreAccepted() {
    var stay = new DateRange(LocalDate.parse("2027-01-01"), LocalDate.parse("2027-03-02"));

    assertThatCode(() -> config(Duration.ofMinutes(15)).requireWithinLimits(stay, 10))
        .doesNotThrowAnyException();
  }

  @Test
  void aStayOverTheNightLimitIsRefused() {
    var stay = new DateRange(LocalDate.parse("2027-01-01"), LocalDate.parse("2027-03-03"));

    assertThatThrownBy(() -> config(Duration.ofMinutes(15)).requireWithinLimits(stay, 1))
        .isInstanceOf(ValidationException.class)
        .hasMessageContaining("60 nights");
  }

  @ParameterizedTest
  @ValueSource(ints = {0, 11})
  void roomCountOutsideTheLimitIsRefused(int rooms) {
    var stay = new DateRange(LocalDate.parse("2027-01-01"), LocalDate.parse("2027-01-02"));

    assertThatThrownBy(() -> config(Duration.ofMinutes(15)).requireWithinLimits(stay, rooms))
        .isInstanceOf(ValidationException.class);
  }
}
