package com.papertrail.workflow.domain;

/**
 * Decides whether a step is still open, approved or rejected from its tasks' decisions. Rules are
 * the same whether the step has one approver or many: a rejection rejects a single, any-of or
 * all-of step at once, while a quorum step rejects only when a quorum can no longer be reached.
 */
public final class StepRules {

  /** The result of applying the rules to the decisions so far. */
  public enum Outcome {
    OPEN,
    APPROVED,
    REJECTED
  }

  private StepRules() {}

  public static Outcome evaluate(
      StepKind kind, int quorum, int assignees, int approvals, int rejections) {
    return switch (kind) {
      case SINGLE, ANY_OF ->
          rejections > 0 ? Outcome.REJECTED : approvals > 0 ? Outcome.APPROVED : Outcome.OPEN;
      case ALL_OF ->
          rejections > 0
              ? Outcome.REJECTED
              : approvals == assignees ? Outcome.APPROVED : Outcome.OPEN;
      case QUORUM ->
          approvals >= quorum
              ? Outcome.APPROVED
              : rejections > assignees - quorum ? Outcome.REJECTED : Outcome.OPEN;
    };
  }

  /** A step can only be activated with approvers, and a quorum must be reachable. */
  public static void requireAssignable(StepKind kind, int quorum, int assignees) {
    if (assignees == 0) {
      throw new ValidationException(
          kind == StepKind.SINGLE
              ? "the approver of a SINGLE step is inactive"
              : kind + " step has no active approvers in its group");
    }
    if (kind == StepKind.QUORUM && quorum > assignees) {
      throw new ValidationException(
          "quorum " + quorum + " exceeds the " + assignees + " approvers of the group");
    }
  }
}
