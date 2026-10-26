package com.innkeep.booking.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.innkeep.booking.config.BookingConfig;
import com.innkeep.booking.domain.ConflictException;
import java.time.Duration;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.springframework.orm.ObjectOptimisticLockingFailureException;

class OptimisticRetryTest {

  private static OptimisticRetry retry(int maxAttempts) {
    return new OptimisticRetry(
        new BookingConfig(
            "token",
            Duration.ofMinutes(15),
            200,
            Duration.ofMinutes(1),
            10,
            60,
            maxAttempts,
            true,
            Duration.ofSeconds(3)));
  }

  private static ObjectOptimisticLockingFailureException lost() {
    return new ObjectOptimisticLockingFailureException("Reservation", 1L);
  }

  @Test
  void rerunsTheUnitOfWorkAfterALostRace() {
    var attempts = new AtomicInteger();

    String result =
        retry(3)
            .run(
                () -> {
                  if (attempts.incrementAndGet() == 1) {
                    throw lost();
                  }
                  return "done";
                });

    assertThat(result).isEqualTo("done");
    assertThat(attempts).hasValue(2);
  }

  @Test
  void givesUpAfterTheConfiguredAttempts() {
    var attempts = new AtomicInteger();

    assertThatThrownBy(
            () ->
                retry(3)
                    .run(
                        () -> {
                          attempts.incrementAndGet();
                          throw lost();
                        }))
        .isInstanceOf(ObjectOptimisticLockingFailureException.class);
    assertThat(attempts).hasValue(3);
  }

  @Test
  void businessConflictsAreNotRetried() {
    var attempts = new AtomicInteger();

    assertThatThrownBy(
            () ->
                retry(3)
                    .run(
                        () -> {
                          attempts.incrementAndGet();
                          throw new ConflictException("already cancelled");
                        }))
        .isInstanceOf(ConflictException.class);
    assertThat(attempts).hasValue(1);
  }
}
