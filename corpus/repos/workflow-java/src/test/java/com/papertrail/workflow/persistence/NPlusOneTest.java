package com.papertrail.workflow.persistence;

import static org.assertj.core.api.Assertions.assertThat;

import com.papertrail.workflow.domain.Principal;
import com.papertrail.workflow.domain.StepKind;
import com.papertrail.workflow.service.DocumentService;
import com.papertrail.workflow.service.TaskQueries;
import com.papertrail.workflow.support.IntegrationTestBase;
import com.papertrail.workflow.support.TestData;
import jakarta.persistence.EntityManagerFactory;
import org.hibernate.SessionFactory;
import org.hibernate.stat.Statistics;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

/**
 * Proves the list reads issue the same number of statements however many rows they return. The
 * counts come from Hibernate statistics, so an accidental per-row query fails the test.
 */
class NPlusOneTest extends IntegrationTestBase {

  @Autowired private DocumentService documents;
  @Autowired private TaskQueries tasks;
  @Autowired private EntityManagerFactory emf;

  private Statistics statistics() {
    return emf.unwrap(SessionFactory.class).getStatistics();
  }

  private long statementsFor(Runnable read) {
    statistics().clear();
    read.run();
    return statistics().getPrepareStatementCount();
  }

  private void createDocuments(int owners, int perOwner) {
    for (int o = 0; o < owners; o++) {
      long owner = data.user("Owner " + o + " of " + System.nanoTime());
      for (int i = 0; i < perOwner; i++) {
        data.draft(data.principal(owner), "Expenses", "Claim " + o + "-" + i);
      }
    }
  }

  @Test
  void documentListsIssueAFixedNumberOfStatements() {
    long approver = data.user("Tomas Vale");
    data.publish("Expenses", TestData.step(1, StepKind.SINGLE, approver, null, 0, 480));
    Principal admin = data.principal(data.admin("Ops Admin"));
    createDocuments(2, 1);
    long small = statementsFor(() -> documents.list(admin, DocumentFilter.NONE, null, 50));

    createDocuments(4, 3);
    long large = statementsFor(() -> documents.list(admin, DocumentFilter.NONE, null, 50));

    assertThat(small).isPositive();
    assertThat(large).isEqualTo(small);
    assertThat(small).isLessThanOrEqualTo(2);
  }

  @Test
  void theApprovalInboxIssuesAFixedNumberOfStatements() {
    long owner = data.user("Ines Berg");
    long approver = data.user("Tomas Vale");
    data.publish("Expenses", TestData.step(1, StepKind.SINGLE, approver, null, 0, 480));
    Principal reviewer = data.principal(approver);
    submitDocuments(owner, 1);
    long small = statementsFor(() -> tasks.openFor(reviewer));

    submitDocuments(owner, 5);
    long large = statementsFor(() -> tasks.openFor(reviewer));

    assertThat(small).isPositive();
    assertThat(large).isEqualTo(small);
  }

  private void submitDocuments(long owner, int count) {
    for (int i = 0; i < count; i++) {
      long id = data.draft(data.principal(owner), "Expenses", "Claim " + System.nanoTime());
      documents.submit(data.principal(owner), id);
    }
  }
}
