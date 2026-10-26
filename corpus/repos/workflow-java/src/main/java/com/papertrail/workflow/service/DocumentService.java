package com.papertrail.workflow.service;

import com.papertrail.workflow.domain.AppUser;
import com.papertrail.workflow.domain.AuditEvent;
import com.papertrail.workflow.domain.Document;
import com.papertrail.workflow.domain.DocumentStateMachine;
import com.papertrail.workflow.domain.DocumentStatus;
import com.papertrail.workflow.domain.ForbiddenException;
import com.papertrail.workflow.domain.NotFoundException;
import com.papertrail.workflow.domain.Principal;
import com.papertrail.workflow.domain.WorkflowDefinition;
import com.papertrail.workflow.persistence.AppUserRepository;
import com.papertrail.workflow.persistence.ApprovalTaskRepository;
import com.papertrail.workflow.persistence.AuditEventRepository;
import com.papertrail.workflow.persistence.DocumentFilter;
import com.papertrail.workflow.persistence.DocumentPermissionRepository;
import com.papertrail.workflow.persistence.DocumentRepository;
import com.papertrail.workflow.persistence.WorkflowDefinitionRepository;
import com.papertrail.workflow.service.Views.AccessView;
import com.papertrail.workflow.service.Views.AuditView;
import com.papertrail.workflow.service.Views.DocumentDetail;
import com.papertrail.workflow.service.Views.DocumentSummary;
import com.papertrail.workflow.service.Views.PageView;
import com.papertrail.workflow.service.Views.PermissionView;
import com.papertrail.workflow.service.Views.TaskView;
import java.time.Clock;
import java.time.Instant;
import java.util.EnumMap;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** Document use cases: drafting, the owner's lifecycle moves, and the permission-filtered reads. */
@Service
public class DocumentService {

  static final int MAX_PAGE = 100;
  static final int DEFAULT_PAGE = 20;

  private final DocumentRepository documents;
  private final WorkflowDefinitionRepository definitions;
  private final AppUserRepository users;
  private final ApprovalTaskRepository tasks;
  private final AuditEventRepository audits;
  private final DocumentPermissionRepository permissions;
  private final DocumentAccess access;
  private final ApprovalService approvals;
  private final EventLog events;
  private final Clock clock;

  public DocumentService(
      DocumentRepository documents,
      WorkflowDefinitionRepository definitions,
      AppUserRepository users,
      ApprovalTaskRepository tasks,
      AuditEventRepository audits,
      DocumentPermissionRepository permissions,
      DocumentAccess access,
      ApprovalService approvals,
      EventLog events,
      Clock clock) {
    this.documents = documents;
    this.definitions = definitions;
    this.users = users;
    this.tasks = tasks;
    this.audits = audits;
    this.permissions = permissions;
    this.access = access;
    this.approvals = approvals;
    this.events = events;
    this.clock = clock;
  }

  @Transactional
  public long create(Principal actor, String title, String body, String definitionName) {
    AppUser owner =
        users.findById(actor.userId()).orElseThrow(() -> new NotFoundException("user not found"));
    if (!owner.isActive()) {
      throw new ForbiddenException("an inactive user cannot create documents");
    }
    WorkflowDefinition definition =
        definitions
            .findFirstByNameAndPublishedTrueOrderByVersionDesc(definitionName.trim())
            .orElseThrow(
                () -> new NotFoundException("no published definition named " + definitionName));
    Instant now = clock.instant();
    Document document = Document.draft(owner, definition, title, body, now);
    documents.save(document);
    events.audit(
        document,
        actor.userId(),
        "CREATED",
        Map.of("definitionVersion", definition.getVersion()),
        now);
    return document.getId();
  }

  @Transactional(readOnly = true)
  public DocumentDetail get(Principal actor, long documentId) {
    Document document = access.visible(actor, documentId);
    List<TaskView> taskViews =
        tasks.findForDocument(documentId).stream().map(TaskView::of).toList();
    return new DocumentDetail(DocumentSummary.of(document), document.getBody(), taskViews);
  }

  /** Lists the documents the caller can see, newest first, after {@code cursor}. */
  @Transactional(readOnly = true)
  public PageView<DocumentSummary> list(
      Principal actor, DocumentFilter filter, Long cursor, Integer size) {
    int limit = size == null ? DEFAULT_PAGE : Math.min(Math.max(size, 1), MAX_PAGE);
    List<Document> rows =
        documents.findVisiblePage(actor.userId(), actor.admin(), filter, cursor, limit + 1);
    boolean more = rows.size() > limit;
    List<DocumentSummary> items = rows.stream().limit(limit).map(DocumentSummary::of).toList();
    Long next = more ? items.get(items.size() - 1).id() : null;
    return new PageView<>(items, next);
  }

  @Transactional(readOnly = true)
  public long count(Principal actor, DocumentFilter filter) {
    return documents.countVisible(actor.userId(), actor.admin(), filter);
  }

  @Transactional
  public void updateDraft(Principal actor, long documentId, String title, String body) {
    Document document = access.lockVisible(actor, documentId);
    Instant now = clock.instant();
    DocumentStateMachine.updateDraft(document, actor, title, body, now);
    events.audit(document, actor.userId(), "UPDATED", Map.of(), now);
  }

  @Transactional
  public void submit(Principal actor, long documentId) {
    Document document = access.lockVisible(actor, documentId);
    Instant now = clock.instant();
    DocumentStateMachine.submit(document, actor, now);
    approvals.activate(document, now);
    events.audit(document, actor.userId(), "SUBMITTED", Map.of("round", document.getRound()), now);
  }

  @Transactional
  public void resubmit(Principal actor, long documentId) {
    Document document = access.lockVisible(actor, documentId);
    Instant now = clock.instant();
    DocumentStateMachine.resubmit(document, actor, now);
    approvals.activate(document, now);
    events.audit(
        document, actor.userId(), "RESUBMITTED", Map.of("round", document.getRound()), now);
  }

  @Transactional
  public void withdraw(Principal actor, long documentId) {
    Document document = access.lockVisible(actor, documentId);
    Instant now = clock.instant();
    DocumentStateMachine.withdraw(document, actor, now);
    approvals.cancelOpenTasks(documentId);
    events.audit(document, actor.userId(), "WITHDRAWN", Map.of(), now);
  }

  /** The document's audit trail, oldest first, keyset-paged. */
  @Transactional(readOnly = true)
  public PageView<AuditView> audit(Principal actor, long documentId, Long cursor, Integer size) {
    access.visible(actor, documentId);
    int limit = Pages.limit(size);
    List<AuditEvent> rows =
        audits.findForDocumentAfter(documentId, Pages.after(cursor), Pages.first(limit));
    return Pages.of(rows, limit, AuditEvent::getId, AuditView::of);
  }

  /** Who can see the document and why: the owner, the approvers, and the explicit grants. */
  @Transactional(readOnly = true)
  public AccessView who(Principal actor, long documentId) {
    Document document = access.visible(actor, documentId);
    List<Long> approvers =
        tasks.findForDocument(documentId).stream()
            .map(task -> task.getAssignee().getId())
            .distinct()
            .sorted()
            .toList();
    List<PermissionView> grants =
        permissions.findForDocument(documentId).stream().map(PermissionView::of).toList();
    return new AccessView(document.getOwner().getId(), approvers, grants);
  }

  /** How many documents the caller can see in each status. */
  @Transactional(readOnly = true)
  public Map<DocumentStatus, Long> summary(Principal actor) {
    Map<DocumentStatus, Long> counts = new EnumMap<>(DocumentStatus.class);
    for (DocumentStatus status : DocumentStatus.values()) {
      counts.put(
          status,
          documents.countVisible(
              actor.userId(), actor.admin(), new DocumentFilter(status, null, null)));
    }
    return counts;
  }
}
