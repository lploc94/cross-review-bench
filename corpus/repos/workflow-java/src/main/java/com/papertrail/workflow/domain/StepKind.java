package com.papertrail.workflow.domain;

/**
 * How a step's approvers decide. {@code SINGLE}: one named approver. {@code ANY_OF}: the first
 * decision by a group member completes the step. {@code ALL_OF}: every member must approve. {@code
 * QUORUM}: a given number of members must approve.
 */
public enum StepKind {
  SINGLE,
  ANY_OF,
  ALL_OF,
  QUORUM;

  public boolean isGroup() {
    return this != SINGLE;
  }
}
