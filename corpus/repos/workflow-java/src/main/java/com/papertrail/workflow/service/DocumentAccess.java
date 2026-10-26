package com.papertrail.workflow.service;

import com.papertrail.workflow.domain.Document;
import com.papertrail.workflow.domain.NotFoundException;
import com.papertrail.workflow.domain.Principal;
import com.papertrail.workflow.persistence.DocumentRepository;
import java.util.Optional;
import org.springframework.stereotype.Component;

/**
 * The one place that decides whether a principal may see a document. A document the caller cannot
 * see is reported as not found, so its existence does not leak.
 */
@Component
class DocumentAccess {

  private final DocumentRepository documents;

  DocumentAccess(DocumentRepository documents) {
    this.documents = documents;
  }

  Document visible(Principal actor, long documentId) {
    Optional<Document> found =
        actor.admin()
            ? documents.findDetailById(documentId)
            : documents.findVisibleById(documentId, actor.userId());
    return found.orElseThrow(() -> new NotFoundException("document not found"));
  }

  /**
   * Locks the row before the read. A document read before the lock could be stale when another
   * transaction commits a change while this one waits, so the lock comes first.
   */
  Document lockVisible(Principal actor, long documentId) {
    documents.lockById(documentId);
    return visible(actor, documentId);
  }
}
