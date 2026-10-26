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
import org.hibernate.annotations.DynamicUpdate;

/**
 * One approver's assignment in one review round. Decided tasks stay as the review's history.
 *
 * <p>Partial updates: a decision writes only the columns it changes, so a timestamp another
 * transaction set (the escalation) is never overwritten by a stale copy.
 */
@DynamicUpdate
@Entity
@Table(name = "approval_task")
public class ApprovalTask extends AbstractEntity<Long> {

  static final int MAX_COMMENT = 1000;

  @Id
  @GeneratedValue(strategy = GenerationType.IDENTITY)
  private Long id;

  @ManyToOne(fetch = FetchType.LAZY, optional = false)
  @JoinColumn(name = "document_id", nullable = false)
  private Document document;

  @Column(nullable = false)
  private int round;

  @Column(name = "step_order", nullable = false)
  private int stepOrder;

  @ManyToOne(fetch = FetchType.LAZY, optional = false)
  @JoinColumn(name = "step_id", nullable = false)
  private StepDefinition step;

  @ManyToOne(fetch = FetchType.LAZY, optional = false)
  @JoinColumn(name = "assignee_id", nullable = false)
  private AppUser assignee;

  @Enumerated(EnumType.STRING)
  @Column(nullable = false, length = 16)
  private TaskStatus status;

  @Column(name = "due_at", nullable = false)
  private Instant dueAt;

  @Column(name = "decided_at")
  private Instant decidedAt;

  @Column(name = "decision_comment", length = MAX_COMMENT)
  private String decisionComment;

  @Column(name = "escalated_at")
  private Instant escalatedAt;

  @Version private Long version;

  protected ApprovalTask() {}

  public ApprovalTask(
      Document document, int round, StepDefinition step, AppUser assignee, Instant dueAt) {
    this.document = document;
    this.round = round;
    this.stepOrder = step.getStepOrder();
    this.step = step;
    this.assignee = assignee;
    this.status = TaskStatus.OPEN;
    this.dueAt = dueAt;
  }

  public boolean isOpen() {
    return status == TaskStatus.OPEN;
  }

  public void decide(Decision decision, String comment, Instant now) {
    if (!isOpen()) {
      throw new ConflictException("task " + id + " is " + status + ", not open");
    }
    String trimmed = comment == null || comment.isBlank() ? null : comment.trim();
    if (trimmed != null && trimmed.length() > MAX_COMMENT) {
      throw new ValidationException("comment may not exceed " + MAX_COMMENT + " characters");
    }
    this.status = decision == Decision.APPROVE ? TaskStatus.APPROVED : TaskStatus.REJECTED;
    this.decidedAt = now;
    this.decisionComment = trimmed;
  }

  /** Closes a task that is no longer needed because its step was decided without it. */
  public void cancel() {
    if (isOpen()) {
      this.status = TaskStatus.CANCELLED;
    }
  }

  @Override
  public Long getId() {
    return id;
  }

  public Document getDocument() {
    return document;
  }

  public int getRound() {
    return round;
  }

  public int getStepOrder() {
    return stepOrder;
  }

  public StepDefinition getStep() {
    return step;
  }

  public AppUser getAssignee() {
    return assignee;
  }

  public TaskStatus getStatus() {
    return status;
  }

  public Instant getDueAt() {
    return dueAt;
  }

  public Instant getDecidedAt() {
    return decidedAt;
  }

  public String getDecisionComment() {
    return decisionComment;
  }

  public Instant getEscalatedAt() {
    return escalatedAt;
  }
}
