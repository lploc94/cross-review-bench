package com.papertrail.workflow.domain;

/** Delivery state of a notification: waiting, delivered, or given up after the last attempt. */
public enum OutboxStatus {
  PENDING,
  SENT,
  FAILED
}
