package com.papertrail.workflow.domain;

/** Life of one approver assignment. {@code CANCELLED} means the step was decided without it. */
public enum TaskStatus {
  OPEN,
  APPROVED,
  REJECTED,
  CANCELLED
}
