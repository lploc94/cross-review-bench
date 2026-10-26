package com.papertrail.workflow.service;

import com.papertrail.workflow.domain.ApiToken;
import com.papertrail.workflow.domain.AppUser;
import com.papertrail.workflow.domain.ApprovalTask;
import com.papertrail.workflow.domain.AuditEvent;
import com.papertrail.workflow.domain.Document;
import com.papertrail.workflow.domain.DocumentPermission;
import com.papertrail.workflow.domain.DocumentStatus;
import com.papertrail.workflow.domain.OutboxEvent;
import com.papertrail.workflow.domain.OutboxStatus;
import com.papertrail.workflow.domain.PermissionLevel;
import com.papertrail.workflow.domain.StepDefinition;
import com.papertrail.workflow.domain.StepKind;
import com.papertrail.workflow.domain.TaskStatus;
import com.papertrail.workflow.domain.UserGroup;
import com.papertrail.workflow.domain.WorkflowDefinition;
import java.time.Instant;
import java.time.LocalTime;
import java.util.Comparator;
import java.util.List;
import java.util.Map;

/**
 * Read models the services return. They are built inside the transaction, so no caller touches a
 * lazy association after the transaction has closed.
 */
public final class Views {

  private Views() {}

  /** One page of a keyset-paginated list; {@code nextCursor} is null on the last page. */
  public record PageView<T>(List<T> items, Long nextCursor) {}

  public record DocumentSummary(
      long id,
      String title,
      long ownerId,
      String ownerName,
      String definitionName,
      int definitionVersion,
      DocumentStatus status,
      int round,
      int currentOrder,
      Instant createdAt,
      Instant updatedAt) {

    public static DocumentSummary of(Document document) {
      return new DocumentSummary(
          document.getId(),
          document.getTitle(),
          document.getOwner().getId(),
          document.getOwner().getDisplayName(),
          document.getDefinition().getName(),
          document.getDefinition().getVersion(),
          document.getStatus(),
          document.getRound(),
          document.getCurrentOrder(),
          document.getCreatedAt(),
          document.getUpdatedAt());
    }
  }

  public record DocumentDetail(DocumentSummary summary, String body, List<TaskView> tasks) {}

  public record TaskView(
      long id,
      long documentId,
      String documentTitle,
      int round,
      int stepOrder,
      StepKind kind,
      TaskStatus status,
      long assigneeId,
      String assigneeName,
      Instant dueAt,
      Instant decidedAt,
      String decisionComment,
      Instant escalatedAt) {

    public static TaskView of(ApprovalTask task) {
      return of(task, task.getEscalatedAt());
    }

    /** The task with the escalation time read by the caller, as it is now in the database. */
    public static TaskView of(ApprovalTask task, Instant escalatedAt) {
      return new TaskView(
          task.getId(),
          task.getDocument().getId(),
          task.getDocument().getTitle(),
          task.getRound(),
          task.getStepOrder(),
          task.getStep().getKind(),
          task.getStatus(),
          task.getAssignee().getId(),
          task.getAssignee().getDisplayName(),
          task.getDueAt(),
          task.getDecidedAt(),
          task.getDecisionComment(),
          escalatedAt);
    }
  }

  public record AuditView(
      long id, long documentId, String action, long actorId, String details, Instant occurredAt) {

    public static AuditView of(AuditEvent event) {
      return new AuditView(
          event.getId(),
          event.getDocument().getId(),
          event.getAction(),
          event.getActor().getId(),
          event.getDetails(),
          event.getOccurredAt());
    }
  }

  public record UserView(long id, String displayName, String email, boolean active, boolean admin) {

    public static UserView of(AppUser user) {
      return new UserView(
          user.getId(), user.getDisplayName(), user.getEmail(), user.isActive(), user.isAdmin());
    }
  }

  public record PermissionView(
      long userId, String displayName, PermissionLevel level, Instant grantedAt) {

    public static PermissionView of(DocumentPermission permission) {
      return new PermissionView(
          permission.getUser().getId(),
          permission.getUser().getDisplayName(),
          permission.getLevel(),
          permission.getGrantedAt());
    }
  }

  public record StepView(
      long id,
      int order,
      StepKind kind,
      String assigneeName,
      String groupName,
      int quorum,
      int slaMinutes) {

    public static StepView of(StepDefinition step) {
      return new StepView(
          step.getId(),
          step.getStepOrder(),
          step.getKind(),
          step.getAssignee() == null ? null : step.getAssignee().getDisplayName(),
          step.getGroup() == null ? null : step.getGroup().getName(),
          step.getQuorum(),
          (int) step.getSla().toMinutes());
    }
  }

  public record DefinitionView(
      long id,
      String name,
      int version,
      boolean published,
      Instant publishedAt,
      List<StepView> steps) {

    public static DefinitionView of(WorkflowDefinition definition) {
      return new DefinitionView(
          definition.getId(),
          definition.getName(),
          definition.getVersion(),
          definition.isPublished(),
          definition.getPublishedAt(),
          definition.getSteps().stream().map(StepView::of).toList());
    }
  }

  public record GroupView(long id, String name, List<UserView> members) {

    public static GroupView of(UserGroup group) {
      List<UserView> members =
          group.getMembers().stream()
              .sorted(Comparator.comparingLong(AppUser::getId))
              .map(UserView::of)
              .toList();
      return new GroupView(group.getId(), group.getName(), members);
    }
  }

  /** A token's lookup prefix and dates. The secret and its hash are never returned. */
  public record TokenView(String prefix, Instant createdAt, Instant revokedAt) {

    public static TokenView of(ApiToken token) {
      return new TokenView(token.getPrefix(), token.getCreatedAt(), token.getRevokedAt());
    }
  }

  /** An outbox row for operators. The recipient and payload are left out on purpose. */
  public record OutboxView(
      long id,
      String idempotencyKey,
      String eventType,
      OutboxStatus status,
      int attempts,
      Instant nextAttemptAt,
      String lastError,
      Instant sentAt) {

    public static OutboxView of(OutboxEvent event) {
      return new OutboxView(
          event.getId(),
          event.getIdempotencyKey(),
          event.getEventType(),
          event.getStatus(),
          event.getAttempts(),
          event.getNextAttemptAt(),
          event.getLastError(),
          event.getSentAt());
    }
  }

  /** One round of a document with the tasks that were opened for it. */
  public record RoundView(int round, List<TaskView> tasks) {}

  /** Counts for the operator dashboard: each one is a single indexed count. */
  public record SummaryView(
      long activeUsers,
      long inactiveUsers,
      Map<DocumentStatus, Long> documents,
      long openTasks,
      long overdueTasks,
      Map<OutboxStatus, Long> outbox) {}

  /** A notification as its recipient sees it: what happened and when, never the payload. */
  public record NotificationView(
      long id, String eventType, OutboxStatus status, Instant createdAt, Instant sentAt) {

    public static NotificationView of(OutboxEvent event) {
      return new NotificationView(
          event.getId(),
          event.getEventType(),
          event.getStatus(),
          event.getCreatedAt(),
          event.getSentAt());
    }
  }

  /** A due time worked out from a start instant and a working-time allowance. */
  public record DueView(Instant from, int minutes, Instant dueAt) {}

  /** Who can see a document: the owner, the users with a task on it, and the explicit grants. */
  public record AccessView(long ownerId, List<Long> approverIds, List<PermissionView> grants) {}

  /** The business calendar an SLA is counted in: zone and the working window of each day. */
  public record WorkingHoursView(String zone, LocalTime start, LocalTime end) {}
}
