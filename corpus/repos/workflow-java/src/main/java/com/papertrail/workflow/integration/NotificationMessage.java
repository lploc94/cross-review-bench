package com.papertrail.workflow.integration;

/**
 * What a notifier receives. The idempotency key is the same on every redelivery of one event, so a
 * receiver that keeps keys can drop the duplicates that at-least-once delivery produces.
 */
public record NotificationMessage(
    String idempotencyKey, String eventType, String recipientEmail, String payload) {}
