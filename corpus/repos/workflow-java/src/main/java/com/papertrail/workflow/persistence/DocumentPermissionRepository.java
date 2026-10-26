package com.papertrail.workflow.persistence;

import com.papertrail.workflow.domain.DocumentPermission;
import java.util.List;
import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface DocumentPermissionRepository extends JpaRepository<DocumentPermission, Long> {

  Optional<DocumentPermission> findByDocumentIdAndUserId(long documentId, long userId);

  @Query(
      "select p from DocumentPermission p join fetch p.user where p.document.id = :docId"
          + " order by p.id")
  List<DocumentPermission> findForDocument(@Param("docId") long documentId);
}
