package com.papertrail.workflow.domain;

/** The document or task is not in a state that allows the requested action. */
public class InvalidTransitionException extends WorkflowException {

  public InvalidTransitionException(String message) {
    super(message);
  }
}
