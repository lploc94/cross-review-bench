package com.papertrail.workflow.persistence;

import com.papertrail.workflow.domain.AuditEvent;
import java.util.List;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface AuditEventRepository extends JpaRepository<AuditEvent, Long> {

  @Query(
      "select e from AuditEvent e join fetch e.actor where e.document.id = :docId"
          + " and e.id > :after order by e.id")
  List<AuditEvent> findForDocumentAfter(
      @Param("docId") long documentId, @Param("after") long after, Pageable page);

  @Query(
      "select e from AuditEvent e join fetch e.actor join fetch e.document where e.id > :after"
          + " order by e.id")
  List<AuditEvent> findAllAfter(@Param("after") long after, Pageable page);
}
