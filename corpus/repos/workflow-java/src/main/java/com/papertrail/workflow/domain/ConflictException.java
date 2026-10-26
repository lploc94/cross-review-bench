package com.papertrail.workflow.domain;

/** The request clashes with the current state of stored data (a lost race, a duplicate key). */
public class ConflictException extends WorkflowException {

  public ConflictException(String message) {
    super(message);
  }
}
