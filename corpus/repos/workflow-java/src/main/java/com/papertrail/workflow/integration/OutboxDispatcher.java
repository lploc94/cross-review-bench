package com.papertrail.workflow.integration;

import static net.logstash.logback.argument.StructuredArguments.kv;

import com.papertrail.workflow.config.WorkflowConfig;
import com.papertrail.workflow.domain.OutboxEvent;
import com.papertrail.workflow.persistence.OutboxEventRepository;
import java.time.Clock;
import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

/**
 * Sends the due outbox events. Claims come with {@code FOR UPDATE SKIP LOCKED}, so instances never
 * send the same event at the same time. Delivery is at least once: a send that succeeds just before
 * the commit fails is sent again, and the idempotency key lets the receiver drop it.
 */
@Component
public class OutboxDispatcher {

  private static final Logger log = LoggerFactory.getLogger(OutboxDispatcher.class);

  /** How many events one batch sent and how many failed and will be retried. */
  public record DispatchResult(int sent, int failed) {}

  private final OutboxEventRepository outbox;
  private final Notifier notifier;
  private final WorkflowConfig properties;
  private final Clock clock;

  public OutboxDispatcher(
      OutboxEventRepository outbox, Notifier notifier, WorkflowConfig properties, Clock clock) {
    this.outbox = outbox;
    this.notifier = notifier;
    this.properties = properties;
    this.clock = clock;
  }

  @Transactional
  public DispatchResult dispatchDue() {
    var now = clock.instant();
    List<OutboxEvent> due = outbox.claimDue(now, properties.outboxBatchSize());
    int sent = 0;
    int failed = 0;
    for (OutboxEvent event : due) {
      try {
        notifier.send(
            new NotificationMessage(
                event.getIdempotencyKey(),
                event.getEventType(),
                event.getRecipientEmail(),
                event.getPayload()));
        event.markSent(now);
        sent++;
      } catch (RuntimeException e) {
        event.recordFailure(
            now,
            e.getClass().getSimpleName(),
            properties.outboxMaxAttempts(),
            properties.outboxRetryBase());
        failed++;
        log.warn(
            "notification failed",
            kv("idempotencyKey", event.getIdempotencyKey()),
            kv("attempts", event.getAttempts()),
            kv("error", e.getClass().getSimpleName()));
      }
    }
    return new DispatchResult(sent, failed);
  }
}
