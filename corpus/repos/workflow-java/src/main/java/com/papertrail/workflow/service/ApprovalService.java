package com.papertrail.workflow.service;

import com.papertrail.workflow.domain.AppUser;
import com.papertrail.workflow.domain.ApprovalTask;
import com.papertrail.workflow.domain.BusinessCalendar;
import com.papertrail.workflow.domain.Decision;
import com.papertrail.workflow.domain.Document;
import com.papertrail.workflow.domain.DocumentStateMachine;
import com.papertrail.workflow.domain.NotFoundException;
import com.papertrail.workflow.domain.Principal;
import com.papertrail.workflow.domain.StepDefinition;
import com.papertrail.workflow.domain.StepKind;
import com.papertrail.workflow.domain.StepRules;
import com.papertrail.workflow.domain.TaskStatus;
import com.papertrail.workflow.persistence.ApprovalTaskRepository;
import com.papertrail.workflow.service.Views.TaskView;
import java.time.Clock;
import java.time.Instant;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.OptionalInt;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Activates steps and records decisions. A decision locks the document row first, so decisions on
 * one review run one at a time: the second of two racing approvers finds its task closed and gets a
 * conflict, and a group step completes once.
 */
@Service
public class ApprovalService {

  private final ApprovalTaskRepository tasks;
  private final DocumentAccess access;
  private final EventLog events;
  private final BusinessCalendar calendar;
  private final Clock clock;

  public ApprovalService(
      ApprovalTaskRepository tasks,
      DocumentAccess access,
      EventLog events,
      BusinessCalendar calendar,
      Clock clock) {
    this.tasks = tasks;
    this.access = access;
    this.events = events;
    this.calendar = calendar;
    this.clock = clock;
  }

  @Transactional
  public TaskView decide(Principal actor, long taskId, Decision decision, String comment) {
    long documentId =
        tasks
            .findDocumentId(taskId)
            .orElseThrow(() -> new NotFoundException("task " + taskId + " not found"));
    Document document = access.lockVisible(actor, documentId);
    ApprovalTask task =
        tasks.findById(taskId).orElseThrow(() -> new NotFoundException("task not found"));
    Instant now = clock.instant();
    DocumentStateMachine.requireDecidable(document, task, actor);
    task.decide(decision, comment, now);
    events.audit(
        document,
        actor.userId(),
        "TASK_" + decision,
        Map.of("taskId", taskId, "order", task.getStepOrder()),
        now);

    StepDefinition step = task.getStep();
    List<ApprovalTask> order =
        tasks.findForOrder(documentId, document.getRound(), document.getCurrentOrder());
    List<ApprovalTask> stepTasks =
        order.stream().filter(other -> other.getStep().getId().equals(step.getId())).toList();
    StepRules.Outcome outcome =
        StepRules.evaluate(
            step.getKind(),
            step.getQuorum(),
            stepTasks.size(),
            count(stepTasks, TaskStatus.APPROVED),
            count(stepTasks, TaskStatus.REJECTED));
    if (outcome == StepRules.Outcome.OPEN) {
      return current(task);
    }
    stepTasks.forEach(ApprovalTask::cancel);
    events.audit(
        document,
        actor.userId(),
        "STEP_" + outcome,
        Map.of("order", step.getStepOrder(), "kind", step.getKind().name()),
        now);
    if (outcome == StepRules.Outcome.REJECTED) {
      order.forEach(ApprovalTask::cancel);
      DocumentStateMachine.reject(document, now);
      events.notify(
          "rejected:" + document.getId() + ":" + document.getRound(),
          "DOCUMENT_REJECTED",
          document.getOwner(),
          Map.of("documentId", document.getId(), "round", document.getRound()),
          now);
      events.audit(document, actor.userId(), "REJECTED", Map.of("round", document.getRound()), now);
      return current(task);
    }
    if (order.stream().noneMatch(ApprovalTask::isOpen)) {
      completeOrder(document, actor, now);
    }
    return current(task);
  }

  /**
   * Creates the open tasks for the document's current order and round, in the caller's transaction.
   */
  public void activate(Document document, Instant now) {
    for (StepDefinition step : document.getDefinition().stepsAt(document.getCurrentOrder())) {
      List<AppUser> assignees = assigneesOf(step);
      StepRules.requireAssignable(step.getKind(), step.getQuorum(), assignees.size());
      Instant due = calendar.dueAt(now, step.getSla());
      for (AppUser assignee : assignees) {
        ApprovalTask task =
            tasks.save(new ApprovalTask(document, document.getRound(), step, assignee, due));
        events.notify(
            "assigned:" + task.getId(),
            "TASK_ASSIGNED",
            assignee,
            Map.of("taskId", task.getId(), "documentId", document.getId(), "dueAt", due.toString()),
            now);
      }
    }
  }

  /** Closes every open task of the document; used when the owner withdraws it. */
  public void cancelOpenTasks(long documentId) {
    tasks.findForDocument(documentId).forEach(ApprovalTask::cancel);
  }

  private void completeOrder(Document document, Principal actor, Instant now) {
    OptionalInt next = document.getDefinition().nextOrderAfter(document.getCurrentOrder());
    if (next.isEmpty()) {
      DocumentStateMachine.approve(document, now);
      events.notify(
          "approved:" + document.getId() + ":" + document.getRound(),
          "DOCUMENT_APPROVED",
          document.getOwner(),
          Map.of("documentId", document.getId(), "round", document.getRound()),
          now);
      events.audit(document, actor.userId(), "APPROVED", Map.of("round", document.getRound()), now);
      return;
    }
    DocumentStateMachine.advanceTo(document, next.getAsInt(), now);
    activate(document, now);
    events.audit(document, actor.userId(), "ADVANCED", Map.of("order", next.getAsInt()), now);
  }

  /** A single step names its approver; a group step takes its active members, by id. */
  private static List<AppUser> assigneesOf(StepDefinition step) {
    if (step.getKind() == StepKind.SINGLE) {
      AppUser assignee = step.getAssignee();
      return assignee.isActive() ? List.of(assignee) : List.of();
    }
    return step.getGroup().getMembers().stream()
        .filter(AppUser::isActive)
        .sorted(Comparator.comparing(AppUser::getId))
        .toList();
  }

  /** The task as it is now: an escalation may have committed since this transaction read it. */
  private TaskView current(ApprovalTask task) {
    return TaskView.of(task, tasks.findEscalatedAt(task.getId()).orElse(null));
  }

  private static int count(List<ApprovalTask> tasks, TaskStatus status) {
    return (int) tasks.stream().filter(task -> task.getStatus() == status).count();
  }
}
