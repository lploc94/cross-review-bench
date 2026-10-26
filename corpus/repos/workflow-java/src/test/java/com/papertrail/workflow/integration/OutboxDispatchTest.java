package com.papertrail.workflow.integration;

import static org.assertj.core.api.Assertions.assertThat;

import com.papertrail.workflow.domain.OutboxStatus;
import com.papertrail.workflow.domain.StepKind;
import com.papertrail.workflow.persistence.OutboxEventRepository;
import com.papertrail.workflow.service.DocumentService;
import com.papertrail.workflow.support.IntegrationTestBase;
import com.papertrail.workflow.support.TestData;
import java.time.Duration;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

class OutboxDispatchTest extends IntegrationTestBase {

  @Autowired private OutboxDispatchJob job;
  @Autowired private OutboxEventRepository outbox;
  @Autowired private DocumentService documents;

  private long reviewer;

  @BeforeEach
  void setUp() {
    long owner = data.user("Ines Berg");
    reviewer = data.user("Tomas Vale");
    data.publish("Expenses", TestData.step(1, StepKind.SINGLE, reviewer, null, 0, 480));
    long document = data.draft(data.principal(owner), "Expenses", "Travel claim");
    documents.submit(data.principal(owner), document);
  }

  private String key() {
    return "assigned:" + taskId();
  }

  private long taskId() {
    return jdbc.queryForObject("select min(id) from approval_task", Long.class);
  }

  @Test
  void eachEventIsSentOnceWithItsIdempotencyKey() {
    assertThat(job.runOnce().sent()).isEqualTo(1);
    assertThat(job.runOnce().sent()).isZero();

    assertThat(notifier.delivered()).hasSize(1);
    assertThat(notifier.delivered().get(0).idempotencyKey()).isEqualTo(key());
    assertThat(outbox.findByIdempotencyKey(key()).orElseThrow().getStatus())
        .isEqualTo(OutboxStatus.SENT);
  }

  @Test
  void aFailedSendWaitsForItsBackoffBeforeRetrying() {
    notifier.failNextDeliveries(1);

    var first = job.runOnce();
    assertThat(first.failed()).isEqualTo(1);
    assertThat(job.runOnce().sent()).isZero();

    clock.advance(Duration.ofSeconds(31));

    assertThat(job.runOnce().sent()).isEqualTo(1);
    assertThat(notifier.delivered()).hasSize(1);
  }

  @Test
  void aLostAcknowledgementRedeliversTheSameKey() {
    notifier.loseNextAcknowledgements(1);

    assertThat(job.runOnce().failed()).isEqualTo(1);
    clock.advance(Duration.ofSeconds(31));
    assertThat(job.runOnce().sent()).isEqualTo(1);

    assertThat(notifier.delivered()).hasSize(2);
    assertThat(notifier.delivered().get(0).idempotencyKey())
        .isEqualTo(notifier.delivered().get(1).idempotencyKey());
    assertThat(outbox.findByIdempotencyKey(key()).orElseThrow().getStatus())
        .isEqualTo(OutboxStatus.SENT);
  }

  @Test
  void anEventIsGivenUpAfterTheLastAttempt() {
    notifier.failNextDeliveries(100);
    for (int i = 0; i < 5; i++) {
      job.runOnce();
      clock.advance(Duration.ofHours(2));
    }

    var event = outbox.findByIdempotencyKey(key()).orElseThrow();
    assertThat(event.getStatus()).isEqualTo(OutboxStatus.FAILED);
    assertThat(event.getAttempts()).isEqualTo(5);
    assertThat(event.getLastError()).isEqualTo("IllegalStateException");
  }

  @Test
  void payloadsCarryIdentifiersButNeverTheDocumentBody() {
    job.runOnce();

    String payload = notifier.delivered().get(0).payload();
    assertThat(payload).contains("\"taskId\"").doesNotContain("Invented body");
    assertThat(
            jdbc.queryForObject(
                "select count(*) from outbox_event where payload like '%Invented body%'",
                Integer.class))
        .isZero();
  }
}
