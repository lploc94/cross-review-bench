package com.papertrail.workflow.service;

import com.papertrail.workflow.domain.ApprovalTask;
import com.papertrail.workflow.domain.NotFoundException;
import com.papertrail.workflow.domain.Principal;
import com.papertrail.workflow.domain.TaskStatus;
import com.papertrail.workflow.persistence.ApprovalTaskRepository;
import com.papertrail.workflow.service.Views.PageView;
import com.papertrail.workflow.service.Views.RoundView;
import com.papertrail.workflow.service.Views.TaskView;
import java.time.Clock;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.stream.Collectors;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Reads of approval tasks: the caller's work, one task, a caller's finished tasks, a document's
 * rounds, and the overdue list for operators.
 */
@Service
public class TaskQueries {

  private final ApprovalTaskRepository tasks;
  private final DocumentAccess access;
  private final Clock clock;

  public TaskQueries(ApprovalTaskRepository tasks, DocumentAccess access, Clock clock) {
    this.tasks = tasks;
    this.access = access;
    this.clock = clock;
  }

  /** The caller's open tasks, most urgent first. */
  @Transactional(readOnly = true)
  public List<TaskView> openFor(Principal actor) {
    return openOf(actor.userId());
  }

  /** How many open tasks the caller has, counted in the database. */
  @Transactional(readOnly = true)
  public long countOpenFor(Principal actor) {
    return tasks.countByAssigneeIdAndStatus(actor.userId(), TaskStatus.OPEN);
  }

  /** Any user's open tasks, most urgent first; the operator view of a person's queue. */
  @Transactional(readOnly = true)
  public List<TaskView> openOf(long userId) {
    return tasks.findForAssignee(userId, TaskStatus.OPEN).stream().map(TaskView::of).toList();
  }

  /**
   * One task. Its assignee may read it; anyone else must be able to see its document, and otherwise
   * gets not found, the same answer as for a task that does not exist.
   */
  @Transactional(readOnly = true)
  public TaskView get(Principal actor, long taskId) {
    ApprovalTask task =
        tasks.findWithAssignee(taskId).orElseThrow(() -> new NotFoundException("task not found"));
    if (actor.userId() != task.getAssignee().getId()) {
      access.visible(actor, task.getDocument().getId());
    }
    return TaskView.of(task);
  }

  /** The caller's finished tasks, oldest first. */
  @Transactional(readOnly = true)
  public PageView<TaskView> decidedFor(Principal actor, Long cursor, Integer size) {
    int limit = Pages.limit(size);
    List<ApprovalTask> rows =
        tasks.findDecidedAfter(
            actor.userId(),
            List.of(TaskStatus.APPROVED, TaskStatus.REJECTED),
            Pages.after(cursor),
            Pages.first(limit));
    return Pages.of(rows, limit, ApprovalTask::getId, TaskView::of);
  }

  /** Open tasks past their due time, for operators, oldest id first. */
  @Transactional(readOnly = true)
  public PageView<TaskView> overdue(Long cursor, Integer size) {
    int limit = Pages.limit(size);
    List<ApprovalTask> rows =
        tasks.findOverdueAfter(
            TaskStatus.OPEN, clock.instant(), Pages.after(cursor), Pages.first(limit));
    return Pages.of(rows, limit, ApprovalTask::getId, TaskView::of);
  }

  /** The document's tasks grouped by round, so earlier rounds and their decisions stay visible. */
  @Transactional(readOnly = true)
  public List<RoundView> rounds(Principal actor, long documentId) {
    access.visible(actor, documentId);
    Map<Integer, List<TaskView>> byRound =
        tasks.findForDocument(documentId).stream()
            .map(TaskView::of)
            .collect(Collectors.groupingBy(TaskView::round, TreeMap::new, Collectors.toList()));
    return byRound.entrySet().stream().map(e -> new RoundView(e.getKey(), e.getValue())).toList();
  }
}
