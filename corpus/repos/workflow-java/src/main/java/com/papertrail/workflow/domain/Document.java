package com.papertrail.workflow.domain;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.FetchType;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.JoinColumn;
import jakarta.persistence.ManyToOne;
import jakarta.persistence.Table;
import jakarta.persistence.Version;
import java.time.Instant;
import java.util.Objects;

/**
 * A document under review. Its state changes only through {@link DocumentStateMachine}, which
 * checks the guards; the package-private mutators here apply the change and stamp it.
 */
@Entity
@Table(name = "document")
public class Document extends AbstractEntity<Long> {

  static final int MAX_TITLE = 200;
  static final int MAX_BODY = 10_000;

  @Id
  @GeneratedValue(strategy = GenerationType.IDENTITY)
  private Long id;

  @Column(nullable = false, length = MAX_TITLE)
  private String title;

  @Column(nullable = false, length = MAX_BODY)
  private String body;

  @ManyToOne(fetch = FetchType.LAZY, optional = false)
  @JoinColumn(name = "owner_id", nullable = false)
  private AppUser owner;

  @ManyToOne(fetch = FetchType.LAZY, optional = false)
  @JoinColumn(name = "definition_id", nullable = false)
  private WorkflowDefinition definition;

  @Enumerated(EnumType.STRING)
  @Column(nullable = false, length = 16)
  private DocumentStatus status;

  @Column(nullable = false)
  private int round;

  @Column(name = "current_order", nullable = false)
  private int currentOrder;

  @Column(name = "created_at", nullable = false)
  private Instant createdAt;

  @Column(name = "updated_at", nullable = false)
  private Instant updatedAt;

  @Version private Long version;

  protected Document() {}

  private Document(
      AppUser owner, WorkflowDefinition definition, String title, String body, Instant now) {
    this.owner = owner;
    this.definition = definition;
    this.title = AppUser.requireText(title, "title", MAX_TITLE);
    this.body = requireBody(body);
    this.status = DocumentStatus.DRAFT;
    this.round = 0;
    this.currentOrder = 0;
    this.createdAt = now;
    this.updatedAt = now;
  }

  /** A new draft pinned to a published definition version. */
  public static Document draft(
      AppUser owner, WorkflowDefinition definition, String title, String body, Instant now) {
    if (!definition.isPublished()) {
      throw new ValidationException("documents start from a published definition");
    }
    return new Document(owner, definition, title, body, now);
  }

  static String requireBody(String body) {
    if (body == null || body.isBlank()) {
      throw new ValidationException("body is required");
    }
    if (body.length() > MAX_BODY) {
      throw new ValidationException("body may not exceed " + MAX_BODY + " characters");
    }
    return body;
  }

  void updateDraft(String newTitle, String newBody, Instant now) {
    this.title = AppUser.requireText(newTitle, "title", MAX_TITLE);
    this.body = requireBody(newBody);
    this.updatedAt = now;
  }

  /** Starts a new review round at the definition's first step order. */
  void startReview(Instant now) {
    this.round++;
    this.status = DocumentStatus.IN_REVIEW;
    this.currentOrder = definition.firstOrder();
    this.updatedAt = now;
  }

  void moveToOrder(int order, Instant now) {
    this.currentOrder = order;
    this.updatedAt = now;
  }

  void approve(Instant now) {
    this.status = DocumentStatus.APPROVED;
    this.updatedAt = now;
  }

  void reject(Instant now) {
    this.status = DocumentStatus.REJECTED;
    this.updatedAt = now;
  }

  void withdraw(Instant now) {
    this.status = DocumentStatus.WITHDRAWN;
    this.updatedAt = now;
  }

  public boolean isOwnedBy(long userId) {
    return Objects.equals(owner.getId(), userId);
  }

  @Override
  public Long getId() {
    return id;
  }

  public String getTitle() {
    return title;
  }

  public String getBody() {
    return body;
  }

  public AppUser getOwner() {
    return owner;
  }

  public WorkflowDefinition getDefinition() {
    return definition;
  }

  public DocumentStatus getStatus() {
    return status;
  }

  public int getRound() {
    return round;
  }

  public int getCurrentOrder() {
    return currentOrder;
  }

  public Instant getCreatedAt() {
    return createdAt;
  }

  public Instant getUpdatedAt() {
    return updatedAt;
  }
}
