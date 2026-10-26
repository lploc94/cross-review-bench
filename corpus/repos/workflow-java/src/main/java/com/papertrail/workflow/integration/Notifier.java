package com.papertrail.workflow.integration;

/**
 * Delivers one notification. An exception means the message was not accepted and may be retried.
 */
public interface Notifier {

  void send(NotificationMessage message);
}
