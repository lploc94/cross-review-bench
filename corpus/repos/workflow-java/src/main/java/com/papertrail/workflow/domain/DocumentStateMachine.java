package com.papertrail.workflow.domain;

import java.time.Instant;

/**
 * The only way a document or task changes state. Each action names its guard: who may act and which
 * status the document must be in. The service locks the document row first, so the guards are
 * checked against the state that will be written.
 */
public final class DocumentStateMachine {

  private DocumentStateMachine() {}

  /** The owner sends a draft for review. */
  public static void submit(Document document, Principal actor, Instant now) {
    requireOwner(document, actor, "submit");
    requireStatus(document, DocumentStatus.DRAFT, "submit");
    document.startReview(now);
  }

  /** The owner sends a rejected document for another round. Earlier decisions stay on record. */
  public static void resubmit(Document document, Principal actor, Instant now) {
    requireOwner(document, actor, "resubmit");
    requireStatus(document, DocumentStatus.REJECTED, "resubmit");
    document.startReview(now);
  }

  /** The owner pulls a document out of review. */
  public static void withdraw(Document document, Principal actor, Instant now) {
    requireOwner(document, actor, "withdraw");
    requireStatus(document, DocumentStatus.IN_REVIEW, "withdraw");
    document.withdraw(now);
  }

  /** The owner edits a draft. Reviewed text is never changed in place. */
  public static void updateDraft(
      Document document, Principal actor, String title, String body, Instant now) {
    requireOwner(document, actor, "update");
    requireStatus(document, DocumentStatus.DRAFT, "update");
    document.updateDraft(title, body, now);
  }

  /** The approval rules reject the document at the step that was just decided. */
  public static void reject(Document document, Instant now) {
    requireStatus(document, DocumentStatus.IN_REVIEW, "reject");
    document.reject(now);
  }

  /** Every step of the last order was approved. */
  public static void approve(Document document, Instant now) {
    requireStatus(document, DocumentStatus.IN_REVIEW, "approve");
    document.approve(now);
  }

  /** The approval rules finished one order and the review moves on to the next. */
  public static void advanceTo(Document document, int order, Instant now) {
    requireStatus(document, DocumentStatus.IN_REVIEW, "advance");
    document.moveToOrder(order, now);
  }

  /** The owner or an admin manages who can see the document. */
  public static void requireManager(Document document, Principal actor) {
    if (!actor.admin() && !document.isOwnedBy(actor.userId())) {
      throw new ForbiddenException("only the owner or an admin may change the sharing");
    }
  }

  /**
   * An approver decides a task only while the document is in review, the task is open, and the task
   * belongs to the round and step order the document is waiting on.
   */
  public static void requireDecidable(Document document, ApprovalTask task, Principal actor) {
    if (task.getAssignee().getId() != actor.userId()) {
      throw new ForbiddenException("this task is assigned to someone else");
    }
    if (document.getStatus() != DocumentStatus.IN_REVIEW) {
      throw new InvalidTransitionException(
          "the document is " + document.getStatus() + ", not in review");
    }
    if (!task.isOpen()
        || task.getRound() != document.getRound()
        || task.getStepOrder() != document.getCurrentOrder()) {
      throw new ConflictException("task " + task.getId() + " is no longer open");
    }
  }

  private static void requireOwner(Document document, Principal actor, String action) {
    if (!document.isOwnedBy(actor.userId())) {
      throw new ForbiddenException("only the owner may " + action + " this document");
    }
  }

  private static void requireStatus(Document document, DocumentStatus expected, String action) {
    if (document.getStatus() != expected) {
      throw new InvalidTransitionException(
          "cannot " + action + " a document that is " + document.getStatus());
    }
  }
}
