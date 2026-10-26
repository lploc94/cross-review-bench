package com.papertrail.workflow.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.papertrail.workflow.domain.AppUser;
import com.papertrail.workflow.domain.AuditEvent;
import com.papertrail.workflow.domain.Document;
import com.papertrail.workflow.domain.OutboxEvent;
import com.papertrail.workflow.persistence.AppUserRepository;
import com.papertrail.workflow.persistence.AuditEventRepository;
import com.papertrail.workflow.persistence.OutboxEventRepository;
import java.time.Instant;
import java.util.Map;
import java.util.TreeMap;
import org.springframework.stereotype.Component;

/**
 * Writes the audit trail and the notification outbox. Callers invoke it inside the transaction that
 * makes the change, so an event exists if and only if the change does.
 */
@Component
public class EventLog {

  private final AuditEventRepository audits;
  private final OutboxEventRepository outbox;
  private final AppUserRepository users;
  private final ObjectMapper json;

  public EventLog(
      AuditEventRepository audits,
      OutboxEventRepository outbox,
      AppUserRepository users,
      ObjectMapper json) {
    this.audits = audits;
    this.outbox = outbox;
    this.users = users;
    this.json = json;
  }

  public void audit(
      Document document, long actorId, String action, Map<String, ?> details, Instant now) {
    audits.save(
        new AuditEvent(document, users.getReferenceById(actorId), action, encode(details), now));
  }

  /** Queues one notification. The key is unique per event; redelivery reuses it. */
  public void notify(
      String idempotencyKey,
      String eventType,
      AppUser recipient,
      Map<String, ?> payload,
      Instant now) {
    outbox.save(
        new OutboxEvent(
            idempotencyKey,
            eventType,
            recipient.getId(),
            recipient.getEmail(),
            encode(payload),
            now));
  }

  private String encode(Map<String, ?> values) {
    try {
      return json.writeValueAsString(new TreeMap<>(values));
    } catch (JsonProcessingException e) {
      throw new IllegalStateException("event details cannot be encoded", e);
    }
  }
}
