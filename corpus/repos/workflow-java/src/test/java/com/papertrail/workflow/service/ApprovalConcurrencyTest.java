package com.papertrail.workflow.service;

import static org.assertj.core.api.Assertions.assertThat;

import com.papertrail.workflow.domain.ConflictException;
import com.papertrail.workflow.domain.Decision;
import com.papertrail.workflow.domain.InvalidTransitionException;
import com.papertrail.workflow.domain.Principal;
import com.papertrail.workflow.domain.StepKind;
import com.papertrail.workflow.support.IntegrationTestBase;
import com.papertrail.workflow.support.TestData;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Two approvers decide at the same time. Each interleaving is forced with latches: the first
 * decision holds its transaction open until the second one is waiting on the document lock.
 */
class ApprovalConcurrencyTest extends IntegrationTestBase {

  @Autowired private ApprovalService approvals;
  @Autowired private DocumentService documents;
  @Autowired private PlatformTransactionManager transactions;

  private ExecutorService pool;
  private long owner;

  @BeforeEach
  void setUp() {
    pool = Executors.newFixedThreadPool(4);
    owner = data.user("Ines Berg");
  }

  @AfterEach
  void tearDown() {
    pool.shutdownNow();
  }

  private static void await(CountDownLatch latch) {
    try {
      if (!latch.await(30, TimeUnit.SECONDS)) {
        throw new IllegalStateException("timed out waiting for the other transaction");
      }
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      throw new IllegalStateException(e);
    }
  }

  private long submitted(String definitionName) {
    long id = data.draft(data.principal(owner), definitionName, "Supplier contract");
    documents.submit(data.principal(owner), id);
    return id;
  }

  @Test
  void twoApproversOfAnyOfAStepCompleteItOnce() throws Exception {
    long a = data.user("Tomas Vale");
    long b = data.user("Lena Hart");
    long group = data.group("finance", a, b);
    data.publish("Expenses", TestData.step(1, StepKind.ANY_OF, null, group, 0, 480));
    long document = submitted("Expenses");
    long taskA = taskOf(document, a);
    long taskB = taskOf(document, b);
    Principal first = data.principal(a);
    Principal second = data.principal(b);
    var template = new TransactionTemplate(transactions);
    var firstDecided = new CountDownLatch(1);
    var secondAttempting = new CountDownLatch(1);

    Future<?> winner =
        pool.submit(
            () ->
                template.executeWithoutResult(
                    status -> {
                      approvals.decide(first, taskA, Decision.APPROVE, null);
                      firstDecided.countDown();
                      await(secondAttempting);
                    }));
    Future<String> loser =
        pool.submit(
            () -> {
              await(firstDecided);
              secondAttempting.countDown();
              try {
                approvals.decide(second, taskB, Decision.APPROVE, null);
                return "decided";
              } catch (ConflictException | InvalidTransitionException e) {
                return e.getClass().getSimpleName();
              }
            });

    winner.get(60, TimeUnit.SECONDS);
    assertThat(loser.get(60, TimeUnit.SECONDS))
        .isIn("ConflictException", "InvalidTransitionException");
    assertThat(
            jdbc.queryForObject(
                "select count(*) from approval_task where document_id = ? and status = 'APPROVED'",
                Integer.class,
                document))
        .isEqualTo(1);
    assertThat(
            jdbc.queryForObject("select status from document where id = ?", String.class, document))
        .isEqualTo("APPROVED");
  }

  @Test
  void theLastOfTwoAllOfApprovalsAdvancesTheReviewOnce() throws Exception {
    long a = data.user("Tomas Vale");
    long b = data.user("Lena Hart");
    long next = data.user("Omar Lind");
    long group = data.group("legal", a, b);
    data.publish(
        "Contract",
        TestData.step(1, StepKind.ALL_OF, null, group, 0, 480),
        TestData.step(2, StepKind.SINGLE, next, null, 0, 480));
    long document = submitted("Contract");
    long taskA = taskOf(document, a);
    long taskB = taskOf(document, b);
    Principal first = data.principal(a);
    Principal second = data.principal(b);
    var template = new TransactionTemplate(transactions);
    var firstDecided = new CountDownLatch(1);
    var secondAttempting = new CountDownLatch(1);

    Future<?> earlier =
        pool.submit(
            () ->
                template.executeWithoutResult(
                    status -> {
                      approvals.decide(first, taskA, Decision.APPROVE, null);
                      firstDecided.countDown();
                      await(secondAttempting);
                    }));
    Future<?> later =
        pool.submit(
            () -> {
              await(firstDecided);
              secondAttempting.countDown();
              approvals.decide(second, taskB, Decision.APPROVE, null);
            });

    earlier.get(60, TimeUnit.SECONDS);
    later.get(60, TimeUnit.SECONDS);

    assertThat(
            jdbc.queryForObject(
                "select count(*) from approval_task where document_id = ? and assignee_id = ?",
                Integer.class,
                document,
                next))
        .isEqualTo(1);
    assertThat(
            jdbc.queryForObject(
                "select count(*) from audit_event where document_id = ? and action = 'ADVANCED'",
                Integer.class,
                document))
        .isEqualTo(1);
  }
}
