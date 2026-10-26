package com.papertrail.workflow.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.papertrail.workflow.domain.Decision;
import com.papertrail.workflow.domain.DocumentStatus;
import com.papertrail.workflow.domain.InvalidTransitionException;
import com.papertrail.workflow.domain.Principal;
import com.papertrail.workflow.domain.StepKind;
import com.papertrail.workflow.domain.ValidationException;
import com.papertrail.workflow.support.IntegrationTestBase;
import com.papertrail.workflow.support.TestData;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

class ApprovalServiceTest extends IntegrationTestBase {

  @Autowired private ApprovalService approvals;
  @Autowired private DocumentService documents;

  private long owner;

  @BeforeEach
  void owner() {
    owner = data.user("Ines Berg");
  }

  private Principal actor(long userId) {
    return data.principal(userId);
  }

  private long submit(String definitionName) {
    long id = data.draft(actor(owner), definitionName, "Supplier contract");
    documents.submit(actor(owner), id);
    return id;
  }

  private String status(long documentId) {
    return jdbc.queryForObject(
        "select status from document where id = ?", String.class, documentId);
  }

  private int count(long documentId, String taskStatus) {
    return jdbc.queryForObject(
        "select count(*) from approval_task where document_id = ? and status = ?",
        Integer.class,
        documentId,
        taskStatus);
  }

  @Test
  void anyOfTheFirstApprovalCompletesTheStepAndCancelsTheOthers() {
    long finance =
        data.group(
            "finance", data.user("Tomas Vale"), data.user("Lena Hart"), data.user("Omar Lind"));
    data.publish("Expenses", TestData.step(1, StepKind.ANY_OF, null, finance, 0, 480));
    long document = submit("Expenses");
    long firstApprover =
        jdbc.queryForObject(
            "select assignee_id from approval_task where document_id = ? order by id limit 1",
            Long.class,
            document);

    approvals.decide(actor(firstApprover), taskOf(document, firstApprover), Decision.APPROVE, null);

    assertThat(status(document)).isEqualTo(DocumentStatus.APPROVED.name());
    assertThat(count(document, "CANCELLED")).isEqualTo(2);
  }

  @Test
  void anAllOfStepAdvancesOnlyWhenTheLastMemberApproves() {
    long first = data.user("Tomas Vale");
    long second = data.user("Lena Hart");
    long reviewer = data.user("Omar Lind");
    long group = data.group("legal", first, second);
    data.publish(
        "Contract",
        TestData.step(1, StepKind.ALL_OF, null, group, 0, 480),
        TestData.step(2, StepKind.SINGLE, reviewer, null, 0, 480));
    long document = submit("Contract");

    approvals.decide(actor(first), taskOf(document, first), Decision.APPROVE, null);
    assertThat(currentOrder(document)).isEqualTo(1);

    approvals.decide(actor(second), taskOf(document, second), Decision.APPROVE, null);
    assertThat(currentOrder(document)).isEqualTo(2);
    assertThat(
            jdbc.queryForObject(
                "select count(*) from approval_task where document_id = ? and assignee_id = ?",
                Integer.class,
                document,
                reviewer))
        .isEqualTo(1);
  }

  @Test
  void aQuorumIsReachedByTheThresholdAndTheRestAreCancelled() {
    long a = data.user("Tomas Vale");
    long b = data.user("Lena Hart");
    long c = data.user("Omar Lind");
    long board = data.group("board", a, b, c);
    data.publish("Board", TestData.step(1, StepKind.QUORUM, null, board, 2, 480));
    long document = submit("Board");

    approvals.decide(actor(a), taskOf(document, a), Decision.APPROVE, null);
    assertThat(status(document)).isEqualTo("IN_REVIEW");
    approvals.decide(actor(b), taskOf(document, b), Decision.APPROVE, null);

    assertThat(status(document)).isEqualTo("APPROVED");
    assertThat(count(document, "CANCELLED")).isEqualTo(1);
  }

  @Test
  void aQuorumIsRejectedOnceItCannotBeReached() {
    long a = data.user("Tomas Vale");
    long b = data.user("Lena Hart");
    long c = data.user("Omar Lind");
    long board = data.group("board", a, b, c);
    data.publish("Board", TestData.step(1, StepKind.QUORUM, null, board, 2, 480));
    long document = submit("Board");

    approvals.decide(actor(a), taskOf(document, a), Decision.REJECT, "Budget unclear");
    assertThat(status(document)).isEqualTo("IN_REVIEW");
    approvals.decide(actor(b), taskOf(document, b), Decision.REJECT, null);

    assertThat(status(document)).isEqualTo("REJECTED");
    assertThat(count(document, "CANCELLED")).isEqualTo(1);
  }

  @Test
  void aRejectionEndsTheOtherStepsOfTheSameOrder() {
    long reviewer = data.user("Tomas Vale");
    long signer = data.user("Lena Hart");
    data.publish(
        "Parallel",
        TestData.step(1, StepKind.SINGLE, reviewer, null, 0, 480),
        TestData.step(1, StepKind.SINGLE, signer, null, 0, 480));
    long document = submit("Parallel");

    approvals.decide(actor(reviewer), taskOf(document, reviewer), Decision.REJECT, null);

    assertThat(status(document)).isEqualTo("REJECTED");
    assertThat(count(document, "CANCELLED")).isEqualTo(1);
    assertThat(count(document, "OPEN")).isZero();
  }

  @Test
  void parallelStepsCompleteTheOrderOnlyWhenAllAreApproved() {
    long reviewer = data.user("Tomas Vale");
    long signer = data.user("Lena Hart");
    long next = data.user("Omar Lind");
    data.publish(
        "Parallel",
        TestData.step(1, StepKind.SINGLE, reviewer, null, 0, 480),
        TestData.step(1, StepKind.SINGLE, signer, null, 0, 480),
        TestData.step(2, StepKind.SINGLE, next, null, 0, 480));
    long document = submit("Parallel");

    approvals.decide(actor(reviewer), taskOf(document, reviewer), Decision.APPROVE, null);
    assertThat(currentOrder(document)).isEqualTo(1);
    approvals.decide(actor(signer), taskOf(document, signer), Decision.APPROVE, null);
    assertThat(currentOrder(document)).isEqualTo(2);
  }

  @Test
  void aFailedAdvanceRollsBackTheApprovalThatCausedIt() {
    long first = data.user("Tomas Vale");
    long emptyGroup = data.group("empty");
    data.publish(
        "Broken",
        TestData.step(1, StepKind.SINGLE, first, null, 0, 480),
        TestData.step(2, StepKind.ANY_OF, null, emptyGroup, 0, 480));
    long document = submit("Broken");
    long task = taskOf(document, first);
    int outboxBefore = count("outbox_event");

    assertThatThrownBy(() -> approvals.decide(actor(first), task, Decision.APPROVE, null))
        .isInstanceOf(ValidationException.class);

    assertThat(
            jdbc.queryForObject(
                "select status from approval_task where id = ?", String.class, task))
        .isEqualTo("OPEN");
    assertThat(currentOrder(document)).isEqualTo(1);
    assertThat(count("outbox_event")).isEqualTo(outboxBefore);
  }

  @Test
  void aDecisionOnAFinishedDocumentIsAnInvalidTransition() {
    long reviewer = data.user("Tomas Vale");
    data.publish("Expenses", TestData.step(1, StepKind.SINGLE, reviewer, null, 0, 480));
    long document = submit("Expenses");
    long task = taskOf(document, reviewer);
    approvals.decide(actor(reviewer), task, Decision.APPROVE, null);

    assertThatThrownBy(() -> approvals.decide(actor(reviewer), task, Decision.APPROVE, null))
        .isInstanceOf(InvalidTransitionException.class);
    assertThatThrownBy(() -> documents.withdraw(actor(owner), document))
        .isInstanceOf(InvalidTransitionException.class);
  }

  private int currentOrder(long document) {
    return jdbc.queryForObject(
        "select current_order from document where id = ?", Integer.class, document);
  }

  private int count(String table) {
    return jdbc.queryForObject("select count(*) from " + table, Integer.class);
  }
}
