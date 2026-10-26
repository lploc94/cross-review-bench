package com.papertrail.workflow.domain;

/** The resource is visible to the caller, but the caller may not perform this action on it. */
public class ForbiddenException extends WorkflowException {

  public ForbiddenException(String message) {
    super(message);
  }
}
