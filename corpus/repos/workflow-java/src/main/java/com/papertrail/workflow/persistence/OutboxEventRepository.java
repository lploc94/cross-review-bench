package com.papertrail.workflow.persistence;

import com.papertrail.workflow.domain.OutboxEvent;
import com.papertrail.workflow.domain.OutboxStatus;
import jakarta.persistence.LockModeType;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface OutboxEventRepository extends JpaRepository<OutboxEvent, Long> {

  /**
   * Pending events due now, locked for this transaction. A dispatcher that finds a row locked by
   * another instance skips it, so every event is claimed by one dispatcher at a time.
   */
  @Query(
      value =
          "select * from outbox_event where status = 'PENDING' and next_attempt_at <= :now"
              + " order by id limit :limit for update skip locked",
      nativeQuery = true)
  List<OutboxEvent> claimDue(@Param("now") Instant now, @Param("limit") int limit);

  @Lock(LockModeType.PESSIMISTIC_WRITE)
  @Query("select e from OutboxEvent e where e.id = :id")
  Optional<OutboxEvent> lockById(@Param("id") long id);

  List<OutboxEvent> findByIdGreaterThanOrderByIdAsc(long after, Pageable page);

  List<OutboxEvent> findByRecipientUserIdAndIdGreaterThanOrderByIdAsc(
      long recipientUserId, long after, Pageable page);

  List<OutboxEvent> findByStatusAndIdGreaterThanOrderByIdAsc(
      OutboxStatus status, long after, Pageable page);

  Optional<OutboxEvent> findByIdempotencyKey(String idempotencyKey);

  long countByEventType(String eventType);

  long countByStatus(OutboxStatus status);

  @Query("select e.id from OutboxEvent e where e.status = :status order by e.id")
  List<Long> findIdsByStatus(@Param("status") OutboxStatus status, Pageable page);
}
