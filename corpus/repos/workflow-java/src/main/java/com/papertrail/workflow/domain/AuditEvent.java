package com.papertrail.workflow.domain;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.FetchType;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.JoinColumn;
import jakarta.persistence.ManyToOne;
import jakarta.persistence.Table;
import java.time.Instant;
import org.hibernate.annotations.Immutable;

/** One entry in a document's append-only audit trail. Details never carry document bodies. */
@Entity
@Table(name = "audit_event")
@Immutable
public class AuditEvent extends AbstractEntity<Long> {

  static final int MAX_DETAILS = 2000;

  @Id
  @GeneratedValue(strategy = GenerationType.IDENTITY)
  private Long id;

  @ManyToOne(fetch = FetchType.LAZY, optional = false)
  @JoinColumn(name = "document_id", nullable = false, updatable = false)
  private Document document;

  @ManyToOne(fetch = FetchType.LAZY, optional = false)
  @JoinColumn(name = "actor_id", nullable = false, updatable = false)
  private AppUser actor;

  @Column(nullable = false, length = 40, updatable = false)
  private String action;

  @Column(nullable = false, length = MAX_DETAILS, updatable = false)
  private String details;

  @Column(name = "occurred_at", nullable = false, updatable = false)
  private Instant occurredAt;

  protected AuditEvent() {}

  public AuditEvent(
      Document document, AppUser actor, String action, String details, Instant occurredAt) {
    this.document = document;
    this.actor = actor;
    this.action = action;
    this.details = details.length() > MAX_DETAILS ? details.substring(0, MAX_DETAILS) : details;
    this.occurredAt = occurredAt;
  }

  @Override
  public Long getId() {
    return id;
  }

  public Document getDocument() {
    return document;
  }

  public AppUser getActor() {
    return actor;
  }

  public String getAction() {
    return action;
  }

  public String getDetails() {
    return details;
  }

  public Instant getOccurredAt() {
    return occurredAt;
  }
}
