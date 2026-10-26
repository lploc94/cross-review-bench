package com.papertrail.workflow.domain;

/** The resource does not exist or is not visible to the caller. */
public class NotFoundException extends WorkflowException {

  public NotFoundException(String message) {
    super(message);
  }
}
