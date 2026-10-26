package com.papertrail.workflow.service;

import com.papertrail.workflow.domain.AuditEvent;
import com.papertrail.workflow.domain.DocumentStatus;
import com.papertrail.workflow.domain.OutboxStatus;
import com.papertrail.workflow.domain.TaskStatus;
import com.papertrail.workflow.persistence.AppUserRepository;
import com.papertrail.workflow.persistence.ApprovalTaskRepository;
import com.papertrail.workflow.persistence.AuditEventRepository;
import com.papertrail.workflow.persistence.DocumentRepository;
import com.papertrail.workflow.persistence.OutboxEventRepository;
import com.papertrail.workflow.service.Views.AuditView;
import com.papertrail.workflow.service.Views.PageView;
import com.papertrail.workflow.service.Views.SummaryView;
import java.time.Clock;
import java.util.EnumMap;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** Counts across the whole system for operators. Nothing is loaded, only counted. */
@Service
public class OperatorSummary {

  private final AppUserRepository users;
  private final DocumentRepository documents;
  private final ApprovalTaskRepository tasks;
  private final OutboxEventRepository outbox;
  private final AuditEventRepository audits;
  private final Clock clock;

  public OperatorSummary(
      AppUserRepository users,
      DocumentRepository documents,
      ApprovalTaskRepository tasks,
      OutboxEventRepository outbox,
      AuditEventRepository audits,
      Clock clock) {
    this.users = users;
    this.documents = documents;
    this.tasks = tasks;
    this.outbox = outbox;
    this.audits = audits;
    this.clock = clock;
  }

  /** The audit trail of every document, oldest first, keyset-paged. */
  @Transactional(readOnly = true)
  public PageView<AuditView> auditTrail(Long cursor, Integer size) {
    int limit = Pages.limit(size);
    List<AuditEvent> rows = audits.findAllAfter(Pages.after(cursor), Pages.first(limit));
    return Pages.of(rows, limit, AuditEvent::getId, AuditView::of);
  }

  @Transactional(readOnly = true)
  public SummaryView summary() {
    Map<DocumentStatus, Long> byStatus = new EnumMap<>(DocumentStatus.class);
    for (DocumentStatus status : DocumentStatus.values()) {
      byStatus.put(status, documents.countByStatus(status));
    }
    Map<OutboxStatus, Long> byOutbox = new EnumMap<>(OutboxStatus.class);
    for (OutboxStatus status : OutboxStatus.values()) {
      byOutbox.put(status, outbox.countByStatus(status));
    }
    return new SummaryView(
        users.countByActive(true),
        users.countByActive(false),
        byStatus,
        tasks.countByStatus(TaskStatus.OPEN),
        tasks.countByStatusAndDueAtLessThanEqual(TaskStatus.OPEN, clock.instant()),
        byOutbox);
  }
}
