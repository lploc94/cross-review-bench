package com.papertrail.workflow.domain;

/** Levels a document owner can grant to a user beyond the implicit approver and owner roles. */
public enum PermissionLevel {
  VIEW,
  COMMENT
}
