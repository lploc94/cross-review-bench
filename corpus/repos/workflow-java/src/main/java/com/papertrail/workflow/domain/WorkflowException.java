package com.papertrail.workflow.domain;

/** Base of the service's own errors; the API maps each subclass to one problem type. */
public abstract class WorkflowException extends RuntimeException {

  protected WorkflowException(String message) {
    super(message);
  }
}
