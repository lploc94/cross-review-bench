package com.papertrail.workflow.domain;

/** Where a document is in its life. Only {@code IN_REVIEW} has open approval tasks. */
public enum DocumentStatus {
  DRAFT,
  IN_REVIEW,
  APPROVED,
  REJECTED,
  WITHDRAWN
}
