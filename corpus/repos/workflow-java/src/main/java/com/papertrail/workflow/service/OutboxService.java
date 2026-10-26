package com.papertrail.workflow.service;

import com.papertrail.workflow.domain.ConflictException;
import com.papertrail.workflow.domain.NotFoundException;
import com.papertrail.workflow.domain.OutboxEvent;
import com.papertrail.workflow.domain.OutboxStatus;
import com.papertrail.workflow.domain.Principal;
import com.papertrail.workflow.persistence.OutboxEventRepository;
import com.papertrail.workflow.service.Views.NotificationView;
import com.papertrail.workflow.service.Views.OutboxView;
import com.papertrail.workflow.service.Views.PageView;
import java.time.Clock;
import java.time.Instant;
import java.util.List;
import org.springframework.data.domain.PageRequest;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** Operator view of the notification outbox: list events by state, requeue a given-up one. */
@Service
public class OutboxService {

  static final int REQUEUE_BATCH = 500;

  private final OutboxEventRepository outbox;
  private final Clock clock;

  public OutboxService(OutboxEventRepository outbox, Clock clock) {
    this.outbox = outbox;
    this.clock = clock;
  }

  @Transactional(readOnly = true)
  public PageView<OutboxView> list(OutboxStatus status, Long cursor, Integer size) {
    int limit = Pages.limit(size);
    PageRequest first = Pages.first(limit);
    long after = Pages.after(cursor);
    List<OutboxEvent> rows =
        status == null
            ? outbox.findByIdGreaterThanOrderByIdAsc(after, first)
            : outbox.findByStatusAndIdGreaterThanOrderByIdAsc(status, after, first);
    return Pages.of(rows, limit, OutboxEvent::getId, OutboxView::of);
  }

  /** The caller's own notifications, oldest first, keyset-paged. */
  @Transactional(readOnly = true)
  public PageView<NotificationView> notificationsFor(Principal actor, Long cursor, Integer size) {
    int limit = Pages.limit(size);
    List<OutboxEvent> rows =
        outbox.findByRecipientUserIdAndIdGreaterThanOrderByIdAsc(
            actor.userId(), Pages.after(cursor), Pages.first(limit));
    return Pages.of(rows, limit, OutboxEvent::getId, NotificationView::of);
  }

  @Transactional(readOnly = true)
  public OutboxView get(long id) {
    return outbox
        .findById(id)
        .map(OutboxView::of)
        .orElseThrow(() -> new NotFoundException("outbox event not found"));
  }

  /** Deletes a failed event that an operator has decided not to send. */
  @Transactional
  public void discard(long id) {
    OutboxEvent event =
        outbox.lockById(id).orElseThrow(() -> new NotFoundException("outbox event not found"));
    if (event.getStatus() != OutboxStatus.FAILED) {
      throw new ConflictException("only a failed event can be discarded");
    }
    outbox.delete(event);
  }

  /** Requeues one batch of failed events, each under its own row lock; returns how many. */
  @Transactional
  public int requeueFailed() {
    Instant now = clock.instant();
    int requeued = 0;
    for (long id : outbox.findIdsByStatus(OutboxStatus.FAILED, PageRequest.of(0, REQUEUE_BATCH))) {
      OutboxEvent event =
          outbox.lockById(id).orElseThrow(() -> new NotFoundException("outbox event not found"));
      if (event.getStatus() == OutboxStatus.FAILED) {
        event.requeue(now);
        requeued++;
      }
    }
    return requeued;
  }

  /**
   * Puts a failed event back in line. The row lock makes two operators requeuing the same event
   * apply it once: the second waits, then finds the event pending and is refused.
   */
  @Transactional
  public OutboxView requeue(long id) {
    OutboxEvent event =
        outbox.lockById(id).orElseThrow(() -> new NotFoundException("outbox event not found"));
    event.requeue(clock.instant());
    return OutboxView.of(event);
  }
}
