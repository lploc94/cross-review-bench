package com.papertrail.workflow.domain;

/** A request or definition breaks a business rule that bean validation cannot express. */
public class ValidationException extends WorkflowException {

  public ValidationException(String message) {
    super(message);
  }
}
