package com.papertrail.workflow.integration;

import static net.logstash.logback.argument.StructuredArguments.kv;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * The default notifier: writes one structured line per message. It never logs the payload or the
 * address.
 */
@Component
public class LoggingNotifier implements Notifier {

  private static final Logger log = LoggerFactory.getLogger(LoggingNotifier.class);

  @Override
  public void send(NotificationMessage message) {
    log.info(
        "notification sent",
        kv("eventType", message.eventType()),
        kv("idempotencyKey", message.idempotencyKey()));
  }
}
