package com.papertrail.workflow.persistence;

import com.papertrail.workflow.domain.ApprovalTask;
import com.papertrail.workflow.domain.TaskStatus;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface ApprovalTaskRepository extends JpaRepository<ApprovalTask, Long> {

  @Query("select t.document.id from ApprovalTask t where t.id = :id")
  Optional<Long> findDocumentId(@Param("id") long id);

  @Query(
      "select t from ApprovalTask t join fetch t.document join fetch t.assignee"
          + " join fetch t.step where t.document.id = :docId order by t.round, t.stepOrder, t.id")
  List<ApprovalTask> findForDocument(@Param("docId") long docId);

  @Query(
      "select t from ApprovalTask t join fetch t.document join fetch t.assignee"
          + " join fetch t.step where t.document.id = :docId and t.round = :round and t.stepOrder = :order"
          + " order by t.id")
  List<ApprovalTask> findForOrder(
      @Param("docId") long docId, @Param("round") int round, @Param("order") int order);

  @Query(
      "select t from ApprovalTask t join fetch t.document d join fetch t.assignee"
          + " join fetch t.step where t.assignee.id = :userId and t.status = :status"
          + " order by t.dueAt, t.id")
  List<ApprovalTask> findForAssignee(
      @Param("userId") long userId, @Param("status") TaskStatus status);

  @Query(
      "select t from ApprovalTask t join fetch t.document join fetch t.assignee"
          + " join fetch t.step where t.assignee.id = :userId and t.status in :decided"
          + " and t.id > :after order by t.id")
  List<ApprovalTask> findDecidedAfter(
      @Param("userId") long userId,
      @Param("decided") List<TaskStatus> decided,
      @Param("after") long after,
      Pageable page);

  @Query(
      "select t from ApprovalTask t join fetch t.document join fetch t.assignee"
          + " join fetch t.step where t.status = :status and t.dueAt <= :now and t.id > :after"
          + " order by t.id")
  List<ApprovalTask> findOverdueAfter(
      @Param("status") TaskStatus status,
      @Param("now") Instant now,
      @Param("after") long after,
      Pageable page);

  long countByStatus(TaskStatus status);

  long countByAssigneeIdAndStatus(long assigneeId, TaskStatus status);

  long countByStatusAndDueAtLessThanEqual(TaskStatus status, Instant now);

  @Query(
      "select t from ApprovalTask t join fetch t.assignee join fetch t.document where t.id = :id")
  Optional<ApprovalTask> findWithAssignee(@Param("id") long id);

  /**
   * Overdue open tasks not yet escalated, locked for this transaction. Rows another instance has
   * locked are skipped, so two instances never escalate the same task.
   */
  @Query(
      value =
          "select id from approval_task where status = 'OPEN' and escalated_at is null"
              + " and due_at <= :now order by due_at, id limit :limit for update skip locked",
      nativeQuery = true)
  List<Long> lockOverdue(@Param("now") Instant now, @Param("limit") int limit);

  /**
   * Marks a locked open task as escalated, once: the timestamp is set only while it is still null.
   */
  @Modifying
  @Query(
      "update ApprovalTask t set t.escalatedAt = :now where t.id = :id and t.escalatedAt is null")
  int markEscalated(@Param("id") long id, @Param("now") Instant now);

  /** The escalation time as the database holds it now, not as this transaction first read it. */
  @Query("select t.escalatedAt from ApprovalTask t where t.id = :id")
  Optional<Instant> findEscalatedAt(@Param("id") long id);
}
