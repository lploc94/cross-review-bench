package com.papertrail.workflow.service;

import static org.assertj.core.api.Assertions.assertThat;

import com.papertrail.workflow.domain.ApprovalTask;
import com.papertrail.workflow.domain.Decision;
import com.papertrail.workflow.domain.StepKind;
import com.papertrail.workflow.persistence.ApprovalTaskRepository;
import com.papertrail.workflow.support.IntegrationTestBase;
import com.papertrail.workflow.support.TestData;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

class SlaEscalationTest extends IntegrationTestBase {

  @Autowired private SlaService sla;
  @Autowired private DocumentService documents;
  @Autowired private ApprovalService approvals;
  @Autowired private ApprovalTaskRepository tasks;
  @Autowired private PlatformTransactionManager transactions;

  private ExecutorService pool;
  private long owner;
  private long reviewer;

  @BeforeEach
  void setUp() {
    pool = Executors.newFixedThreadPool(2);
    owner = data.user("Ines Berg");
    reviewer = data.user("Tomas Vale");
    data.publish("Expenses", TestData.step(1, StepKind.SINGLE, reviewer, null, 0, 60));
  }

  @AfterEach
  void tearDown() {
    pool.shutdownNow();
  }

  private long submitted() {
    long id = data.draft(data.principal(owner), "Expenses", "Travel claim");
    documents.submit(data.principal(owner), id);
    return id;
  }

  private int escalatedCount() {
    return jdbc.queryForObject(
        "select count(*) from approval_task where escalated_at is not null", Integer.class);
  }

  @Test
  void anOverdueTaskIsEscalatedExactlyOnce() {
    submitted();
    // the task is due at 12:00 BST (11:00Z); the clock moves to 13:00 BST
    clock.advance(Duration.ofHours(3));

    assertThat(sla.escalateOverdue(10)).isEqualTo(1);
    assertThat(sla.escalateOverdue(10)).isZero();
    assertThat(escalatedCount()).isEqualTo(1);
    assertThat(
            jdbc.queryForObject(
                "select count(*) from outbox_event where event_type = 'TASK_ESCALATED'",
                Integer.class))
        .isEqualTo(1);
  }

  @Test
  void aTaskIsNotEscalatedBeforeItIsDue() {
    submitted();
    clock.advance(Duration.ofMinutes(30));

    assertThat(sla.escalateOverdue(10)).isZero();
  }

  @Test
  void aDecidedTaskIsNeverEscalated() {
    long document = submitted();
    long task =
        jdbc.queryForObject(
            "select id from approval_task where document_id = ?", Long.class, document);
    approvals.decide(data.principal(reviewer), task, Decision.APPROVE, null);
    clock.advance(Duration.ofHours(3));

    assertThat(sla.escalateOverdue(10)).isZero();
  }

  @Test
  void twoInstancesNeverEscalateTheSameTask() throws Exception {
    long group = data.group("finance", reviewer, data.user("Lena Hart"));
    data.publish("Board", TestData.step(1, StepKind.ALL_OF, null, group, 0, 60));
    long document = data.draft(data.principal(owner), "Board", "Board paper");
    documents.submit(data.principal(owner), document);
    clock.advance(Duration.ofHours(3));
    var template = new TransactionTemplate(transactions);
    var firstLocked = new CountDownLatch(1);
    var secondDone = new CountDownLatch(1);
    var claimed = new AtomicReference<List<Long>>();

    Future<?> holder =
        pool.submit(
            () ->
                template.executeWithoutResult(
                    status -> {
                      claimed.set(tasks.lockOverdue(clock.instant(), 1));
                      firstLocked.countDown();
                      await(secondDone);
                    }));
    Future<Integer> other =
        pool.submit(
            () -> {
              await(firstLocked);
              try {
                return sla.escalateOverdue(1);
              } finally {
                secondDone.countDown();
              }
            });

    assertThat(other.get(60, TimeUnit.SECONDS)).isEqualTo(1);
    holder.get(60, TimeUnit.SECONDS);
    Long skipped = claimed.get().get(0);
    ApprovalTask taken = tasks.findById(skipped).orElseThrow();
    assertThat(taken.getEscalatedAt()).isNull();
    assertThat(escalatedCount()).isEqualTo(1);
  }

  private static void await(CountDownLatch latch) {
    try {
      if (!latch.await(30, TimeUnit.SECONDS)) {
        throw new IllegalStateException("timed out");
      }
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      throw new IllegalStateException(e);
    }
  }
}
