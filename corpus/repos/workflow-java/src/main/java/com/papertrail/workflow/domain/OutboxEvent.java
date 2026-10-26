package com.papertrail.workflow.domain;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.time.Duration;
import java.time.Instant;

/**
 * A notification written in the same transaction as the state change it announces. The idempotency
 * key is unique per event, so a receiver can drop a redelivered copy. The recipient is an account;
 * the address is the one it was sent to, kept for delivery.
 */
@Entity
@Table(name = "outbox_event")
public class OutboxEvent extends AbstractEntity<Long> {

  static final int MAX_ERROR = 200;
  static final Duration MAX_BACKOFF = Duration.ofHours(1);

  @Id
  @GeneratedValue(strategy = GenerationType.IDENTITY)
  private Long id;

  @Column(name = "idempotency_key", nullable = false, unique = true, length = 120)
  private String idempotencyKey;

  @Column(name = "event_type", nullable = false, length = 40)
  private String eventType;

  @Column(name = "recipient_user_id", nullable = false)
  private long recipientUserId;

  @Column(name = "recipient_email", nullable = false, length = 254)
  private String recipientEmail;

  @Column(nullable = false, length = 4000)
  private String payload;

  @Enumerated(EnumType.STRING)
  @Column(nullable = false, length = 16)
  private OutboxStatus status;

  @Column(nullable = false)
  private int attempts;

  @Column(name = "next_attempt_at", nullable = false)
  private Instant nextAttemptAt;

  @Column(name = "last_error", length = MAX_ERROR)
  private String lastError;

  @Column(name = "created_at", nullable = false)
  private Instant createdAt;

  @Column(name = "sent_at")
  private Instant sentAt;

  protected OutboxEvent() {}

  public OutboxEvent(
      String idempotencyKey,
      String eventType,
      long recipientUserId,
      String recipientEmail,
      String payload,
      Instant createdAt) {
    if (payload.length() > 4000) {
      throw new IllegalArgumentException("outbox payload is too large");
    }
    this.idempotencyKey = idempotencyKey;
    this.eventType = eventType;
    this.recipientUserId = recipientUserId;
    this.recipientEmail = recipientEmail;
    this.payload = payload;
    this.status = OutboxStatus.PENDING;
    this.attempts = 0;
    this.nextAttemptAt = createdAt;
    this.createdAt = createdAt;
  }

  public void markSent(Instant now) {
    this.status = OutboxStatus.SENT;
    this.sentAt = now;
    this.lastError = null;
  }

  /**
   * Records a failed delivery. The next attempt waits {@code base} doubled for each earlier
   * failure, up to an hour; after {@code maxAttempts} failures the event is given up.
   */
  public void recordFailure(Instant now, String error, int maxAttempts, Duration base) {
    this.attempts++;
    this.lastError = error.length() > MAX_ERROR ? error.substring(0, MAX_ERROR) : error;
    if (attempts >= maxAttempts) {
      this.status = OutboxStatus.FAILED;
      return;
    }
    long doublings = Math.min(attempts - 1, 20);
    Duration backoff = base.multipliedBy(1L << doublings);
    this.nextAttemptAt = now.plus(backoff.compareTo(MAX_BACKOFF) > 0 ? MAX_BACKOFF : backoff);
  }

  /**
   * Puts a given-up event back in line with its attempts cleared. The last error stays, so the
   * reason it failed is still on the row.
   */
  public void requeue(Instant now) {
    if (status != OutboxStatus.FAILED) {
      throw new ConflictException("only a failed event can be requeued");
    }
    this.status = OutboxStatus.PENDING;
    this.attempts = 0;
    this.nextAttemptAt = now;
  }

  @Override
  public Long getId() {
    return id;
  }

  public String getIdempotencyKey() {
    return idempotencyKey;
  }

  public String getEventType() {
    return eventType;
  }

  public long getRecipientUserId() {
    return recipientUserId;
  }

  public String getRecipientEmail() {
    return recipientEmail;
  }

  public String getPayload() {
    return payload;
  }

  public OutboxStatus getStatus() {
    return status;
  }

  public int getAttempts() {
    return attempts;
  }

  public Instant getNextAttemptAt() {
    return nextAttemptAt;
  }

  public String getLastError() {
    return lastError;
  }

  public Instant getCreatedAt() {
    return createdAt;
  }

  public Instant getSentAt() {
    return sentAt;
  }
}
