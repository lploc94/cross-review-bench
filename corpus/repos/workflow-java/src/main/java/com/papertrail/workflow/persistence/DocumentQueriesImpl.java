package com.papertrail.workflow.persistence;

import com.papertrail.workflow.domain.Document;
import jakarta.persistence.EntityManager;
import jakarta.persistence.PersistenceContext;
import jakarta.persistence.TypedQuery;
import java.util.List;
import org.springframework.stereotype.Repository;

/** Builds the visible-document queries; the filter clauses are added only when they apply. */
@Repository
public class DocumentQueriesImpl implements DocumentQueries {

  @PersistenceContext private EntityManager em;

  @Override
  public List<Document> findVisiblePage(
      long userId, boolean admin, DocumentFilter filter, Long afterId, int limit) {
    StringBuilder jpql =
        new StringBuilder(
            "select d from Document d join fetch d.owner join fetch d.definition where 1 = 1");
    appendFilters(jpql, admin, filter, afterId != null);
    jpql.append(" order by d.id desc");
    TypedQuery<Document> query = em.createQuery(jpql.toString(), Document.class);
    bind(query, userId, admin, filter);
    if (afterId != null) {
      query.setParameter("afterId", afterId);
    }
    return query.setMaxResults(limit).getResultList();
  }

  @Override
  public long countVisible(long userId, boolean admin, DocumentFilter filter) {
    StringBuilder jpql = new StringBuilder("select count(d) from Document d where 1 = 1");
    appendFilters(jpql, admin, filter, false);
    TypedQuery<Long> query = em.createQuery(jpql.toString(), Long.class);
    bind(query, userId, admin, filter);
    return query.getSingleResult();
  }

  private static void appendFilters(
      StringBuilder jpql, boolean admin, DocumentFilter filter, boolean keyset) {
    if (!admin) {
      jpql.append(" and ").append(DocumentQueries.VISIBLE_TO_USER);
    }
    if (filter.status() != null) {
      jpql.append(" and d.status = :status");
    }
    if (filter.ownerId() != null) {
      jpql.append(" and d.owner.id = :ownerId");
    }
    if (filter.definitionName() != null) {
      jpql.append(" and d.definition.name = :definitionName");
    }
    if (filter.sharedWithMe()) {
      jpql.append(
          " and exists (select p.id from DocumentPermission p where p.document = d"
              + " and p.user.id = :userId)");
    }
    if (keyset) {
      jpql.append(" and d.id < :afterId");
    }
  }

  private static void bind(TypedQuery<?> query, long userId, boolean admin, DocumentFilter filter) {
    if (!admin || filter.sharedWithMe()) {
      query.setParameter("userId", userId);
    }
    if (filter.status() != null) {
      query.setParameter("status", filter.status());
    }
    if (filter.ownerId() != null) {
      query.setParameter("ownerId", filter.ownerId());
    }
    if (filter.definitionName() != null) {
      query.setParameter("definitionName", filter.definitionName());
    }
  }
}
