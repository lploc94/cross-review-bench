package com.papertrail.workflow.service;

import com.papertrail.workflow.domain.ApprovalTask;
import com.papertrail.workflow.persistence.ApprovalTaskRepository;
import java.time.Clock;
import java.util.Map;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Escalates overdue tasks. The row lock comes from {@code FOR UPDATE SKIP LOCKED}, and the mark is
 * a direct update that leaves the task's version alone, so an approval that loaded the task just
 * before the escalation still commits. The notification is queued in the same transaction as the
 * mark, so a task is escalated exactly once even with several instances.
 */
@Service
public class SlaService {

  private final ApprovalTaskRepository tasks;
  private final EventLog events;
  private final Clock clock;

  public SlaService(ApprovalTaskRepository tasks, EventLog events, Clock clock) {
    this.tasks = tasks;
    this.events = events;
    this.clock = clock;
  }

  /** Escalates up to {@code limit} overdue tasks; returns how many this call escalated. */
  @Transactional
  public int escalateOverdue(int limit) {
    var now = clock.instant();
    int escalated = 0;
    for (Long taskId : tasks.lockOverdue(now, limit)) {
      if (tasks.markEscalated(taskId, now) == 0) {
        continue;
      }
      ApprovalTask task =
          tasks
              .findWithAssignee(taskId)
              .orElseThrow(() -> new IllegalStateException("task vanished"));
      events.notify(
          "escalated:" + taskId,
          "TASK_ESCALATED",
          task.getAssignee(),
          Map.of(
              "taskId", taskId,
              "documentId", task.getDocument().getId(),
              "dueAt", task.getDueAt().toString()),
          now);
      escalated++;
    }
    return escalated;
  }
}
