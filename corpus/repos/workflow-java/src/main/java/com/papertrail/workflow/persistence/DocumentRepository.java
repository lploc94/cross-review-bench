package com.papertrail.workflow.persistence;

import com.papertrail.workflow.domain.Document;
import com.papertrail.workflow.domain.DocumentStatus;
import jakarta.persistence.LockModeType;
import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface DocumentRepository extends JpaRepository<Document, Long>, DocumentQueries {

  long countByStatus(DocumentStatus status);

  /** Takes the document row lock. Every change to a review runs under it. */
  @Lock(LockModeType.PESSIMISTIC_WRITE)
  @Query("select d from Document d where d.id = :id")
  Optional<Document> lockById(@Param("id") long id);

  @Query("select d from Document d join fetch d.owner join fetch d.definition where d.id = :id")
  Optional<Document> findDetailById(@Param("id") long id);

  @Query(
      "select d from Document d join fetch d.owner join fetch d.definition where d.id = :id and "
          + VISIBLE_TO_USER)
  Optional<Document> findVisibleById(@Param("id") long id, @Param("userId") long userId);
}
