package com.papertrail.workflow.persistence;

import com.papertrail.workflow.domain.Document;
import java.util.List;

/**
 * Document lists and counts. Every query carries the permission filter: a user sees a document only
 * as its owner, one of its approvers (current or past), or someone the owner granted a level.
 * Admins see everything.
 */
public interface DocumentQueries {

  /** The visibility predicate on alias {@code d}; the caller binds {@code :userId}. */
  String VISIBLE_TO_USER =
      "(d.owner.id = :userId"
          + " or exists (select t.id from ApprovalTask t where t.document = d and t.assignee.id ="
          + " :userId)"
          + " or exists (select p.id from DocumentPermission p where p.document = d and p.user.id"
          + " = :userId))";

  /** Visible documents, newest first, after the cursor id. Fetches owner and definition. */
  List<Document> findVisiblePage(
      long userId, boolean admin, DocumentFilter filter, Long afterId, int limit);

  long countVisible(long userId, boolean admin, DocumentFilter filter);
}
