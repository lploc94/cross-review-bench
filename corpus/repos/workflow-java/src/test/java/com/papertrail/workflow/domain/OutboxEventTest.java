package com.papertrail.workflow.domain;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Duration;
import java.time.Instant;
import org.junit.jupiter.api.Test;

class OutboxEventTest {

  private static final Instant NOW = Instant.parse("2027-05-03T10:00:00Z");
  private static final Duration BASE = Duration.ofSeconds(30);

  private OutboxEvent event() {
    return new OutboxEvent("assigned:1", "TASK_ASSIGNED", 7L, "ines@example.com", "{}", NOW);
  }

  @Test
  void aNewEventIsDueImmediately() {
    OutboxEvent event = event();

    assertThat(event.getStatus()).isEqualTo(OutboxStatus.PENDING);
    assertThat(event.getNextAttemptAt()).isEqualTo(NOW);
  }

  @Test
  void theRetryDelayDoublesWithEachFailure() {
    OutboxEvent event = event();

    event.recordFailure(NOW, "IllegalStateException", 5, BASE);
    assertThat(event.getNextAttemptAt()).isEqualTo(NOW.plusSeconds(30));
    event.recordFailure(NOW, "IllegalStateException", 5, BASE);
    assertThat(event.getNextAttemptAt()).isEqualTo(NOW.plusSeconds(60));
    event.recordFailure(NOW, "IllegalStateException", 5, BASE);
    assertThat(event.getNextAttemptAt()).isEqualTo(NOW.plusSeconds(120));
    assertThat(event.getAttempts()).isEqualTo(3);
  }

  @Test
  void theRetryDelayIsCappedAtAnHour() {
    OutboxEvent event = event();
    for (int i = 0; i < 9; i++) {
      event.recordFailure(NOW, "IllegalStateException", 50, BASE);
    }

    assertThat(event.getNextAttemptAt()).isEqualTo(NOW.plus(Duration.ofHours(1)));
    assertThat(event.getStatus()).isEqualTo(OutboxStatus.PENDING);
  }

  @Test
  void anEventIsGivenUpAfterTheLastAttempt() {
    OutboxEvent event = event();
    for (int i = 0; i < 5; i++) {
      event.recordFailure(NOW, "IllegalStateException", 5, BASE);
    }

    assertThat(event.getStatus()).isEqualTo(OutboxStatus.FAILED);
    assertThat(event.getLastError()).isEqualTo("IllegalStateException");
  }

  @Test
  void aSentEventClearsItsLastError() {
    OutboxEvent event = event();
    event.recordFailure(NOW, "IllegalStateException", 5, BASE);

    event.markSent(NOW.plusSeconds(40));

    assertThat(event.getStatus()).isEqualTo(OutboxStatus.SENT);
    assertThat(event.getLastError()).isNull();
    assertThat(event.getSentAt()).isEqualTo(NOW.plusSeconds(40));
  }
}
