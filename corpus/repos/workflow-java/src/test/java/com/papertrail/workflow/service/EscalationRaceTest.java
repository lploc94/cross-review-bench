package com.papertrail.workflow.service;

import static org.assertj.core.api.Assertions.assertThat;

import com.papertrail.workflow.domain.Decision;
import com.papertrail.workflow.domain.DocumentStatus;
import com.papertrail.workflow.domain.StepKind;
import com.papertrail.workflow.domain.TaskStatus;
import com.papertrail.workflow.persistence.ApprovalTaskRepository;
import com.papertrail.workflow.persistence.DocumentRepository;
import com.papertrail.workflow.service.Views.TaskView;
import com.papertrail.workflow.support.IntegrationTestBase;
import com.papertrail.workflow.support.TestConfig;
import com.papertrail.workflow.support.TestData;
import java.time.Duration;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * An approval that loaded its task before the SLA job escalated it must still succeed: escalation
 * sets a timestamp, it does not change the decision the approver is making.
 */
class EscalationRaceTest extends IntegrationTestBase {

  @Autowired private ApprovalService approvals;
  @Autowired private SlaService sla;
  @Autowired private DocumentService documents;
  @Autowired private ApprovalTaskRepository tasks;
  @Autowired private DocumentRepository documentRows;
  @Autowired private PlatformTransactionManager transactions;

  @Test
  void anApprovalThatRacesAnEscalationStillSucceeds() throws Exception {
    long owner = data.user("Ines Berg");
    long approver = data.user("Tomas Vale");
    data.publish("Contract", TestData.step(1, StepKind.SINGLE, approver, null, 0, 480));
    long document = data.draft(data.principal(owner), "Contract", "Race contract");
    documents.submit(data.principal(owner), document);
    long task = taskOf(document, approver);
    clock.set(TestConfig.START.plus(Duration.ofDays(2)));

    CountDownLatch loaded = new CountDownLatch(1);
    CountDownLatch escalated = new CountDownLatch(1);
    ExecutorService pool = Executors.newSingleThreadExecutor();
    try {
      // The approver's transaction loads the task first and waits for the escalation to commit.
      Future<TaskView> decision =
          pool.submit(
              () ->
                  new TransactionTemplate(transactions)
                      .execute(
                          status -> {
                            tasks.findById(task).orElseThrow();
                            loaded.countDown();
                            await(escalated);
                            return approvals.decide(
                                data.principal(approver), task, Decision.APPROVE, "Checked");
                          }));
      assertThat(loaded.await(10, TimeUnit.SECONDS)).isTrue();

      assertThat(sla.escalateOverdue(10)).isEqualTo(1);
      escalated.countDown();

      TaskView view = decision.get(10, TimeUnit.SECONDS);
      assertThat(view.escalatedAt())
          .as("the returned task shows the escalation that committed while the decision waited")
          .isNotNull();
    } finally {
      pool.shutdownNow();
    }
    assertThat(tasks.findById(task).orElseThrow().getStatus()).isEqualTo(TaskStatus.APPROVED);
    assertThat(documentRows.findDetailById(document).orElseThrow().getStatus())
        .isEqualTo(DocumentStatus.APPROVED);
    assertThat(sla.escalateOverdue(10)).as("an escalated task is never escalated again").isZero();
  }

  private static void await(CountDownLatch latch) {
    try {
      if (!latch.await(10, TimeUnit.SECONDS)) {
        throw new IllegalStateException("the escalation never committed");
      }
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      throw new IllegalStateException(e);
    }
  }
}
