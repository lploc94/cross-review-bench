package com.papertrail.workflow.domain;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Instant;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.test.util.ReflectionTestUtils;

class DocumentStateMachineTest {

  private static final Instant NOW = Instant.parse("2027-05-03T10:00:00Z");
  private static final long OWNER = 1L;
  private static final long APPROVER = 2L;
  private static final long STRANGER = 3L;

  private AppUser owner;
  private AppUser approver;
  private AppUser stranger;
  private WorkflowDefinition definition;
  private Document document;

  @BeforeEach
  void setUp() {
    owner = new AppUser("Ines Berg", "ines@example.com", false);
    approver = new AppUser("Tomas Vale", "tomas@example.com", false);
    stranger = new AppUser("Nadia Roy", "nadia@example.com", false);
    ReflectionTestUtils.setField(owner, "id", OWNER);
    ReflectionTestUtils.setField(approver, "id", APPROVER);
    ReflectionTestUtils.setField(stranger, "id", STRANGER);
    definition = new WorkflowDefinition("Expenses", 1, NOW);
    definition.addStep(1, StepKind.SINGLE, approver, null, 0, 480);
    definition.publish(NOW);
    document = Document.draft(owner, definition, "Travel claim", "Invented claim text", NOW);
  }

  @Test
  void submitStartsRoundOneAtTheFirstOrder() {
    DocumentStateMachine.submit(document, new Principal(OWNER, false), NOW);

    assertThat(document.getStatus()).isEqualTo(DocumentStatus.IN_REVIEW);
    assertThat(document.getRound()).isEqualTo(1);
    assertThat(document.getCurrentOrder()).isEqualTo(1);
  }

  @Test
  void onlyTheOwnerMaySubmit() {
    assertThatThrownBy(
            () -> DocumentStateMachine.submit(document, new Principal(STRANGER, false), NOW))
        .isInstanceOf(ForbiddenException.class);
  }

  @Test
  void aDocumentIsSubmittedOnlyFromDraft() {
    DocumentStateMachine.submit(document, new Principal(OWNER, false), NOW);

    assertThatThrownBy(
            () -> DocumentStateMachine.submit(document, new Principal(OWNER, false), NOW))
        .isInstanceOf(InvalidTransitionException.class);
  }

  @Test
  void resubmitIsOnlyAllowedAfterRejection() {
    assertThatThrownBy(
            () -> DocumentStateMachine.resubmit(document, new Principal(OWNER, false), NOW))
        .isInstanceOf(InvalidTransitionException.class);
  }

  @Test
  void aRejectedDocumentStartsANewRound() {
    DocumentStateMachine.submit(document, new Principal(OWNER, false), NOW);
    DocumentStateMachine.reject(document, NOW);

    DocumentStateMachine.resubmit(document, new Principal(OWNER, false), NOW);

    assertThat(document.getStatus()).isEqualTo(DocumentStatus.IN_REVIEW);
    assertThat(document.getRound()).isEqualTo(2);
  }

  @Test
  void withdrawNeedsTheOwnerAndAReviewInProgress() {
    assertThatThrownBy(
            () -> DocumentStateMachine.withdraw(document, new Principal(OWNER, false), NOW))
        .isInstanceOf(InvalidTransitionException.class);
    DocumentStateMachine.submit(document, new Principal(OWNER, false), NOW);

    assertThatThrownBy(
            () -> DocumentStateMachine.withdraw(document, new Principal(STRANGER, false), NOW))
        .isInstanceOf(ForbiddenException.class);
    DocumentStateMachine.withdraw(document, new Principal(OWNER, false), NOW);
    assertThat(document.getStatus()).isEqualTo(DocumentStatus.WITHDRAWN);
  }

  @Test
  void draftsCanBeEditedOnlyByTheOwnerAndOnlyBeforeReview() {
    DocumentStateMachine.updateDraft(
        document, new Principal(OWNER, false), "Travel claim", "New text", NOW);
    assertThat(document.getBody()).isEqualTo("New text");

    assertThatThrownBy(
            () ->
                DocumentStateMachine.updateDraft(
                    document, new Principal(STRANGER, false), "Travel claim", "Other", NOW))
        .isInstanceOf(ForbiddenException.class);
    DocumentStateMachine.submit(document, new Principal(OWNER, false), NOW);
    assertThatThrownBy(
            () ->
                DocumentStateMachine.updateDraft(
                    document, new Principal(OWNER, false), "Travel claim", "Late", NOW))
        .isInstanceOf(InvalidTransitionException.class);
  }

  @Test
  void onlyAnOpenTaskOfTheCurrentStepMayBeDecided() {
    DocumentStateMachine.submit(document, new Principal(OWNER, false), NOW);
    var step = definition.stepsAt(1).get(0);
    var task = new ApprovalTask(document, 1, step, approver, NOW);
    var principal = new Principal(APPROVER, false);

    DocumentStateMachine.requireDecidable(document, task, principal);

    assertThatThrownBy(
            () -> DocumentStateMachine.requireDecidable(document, task, new Principal(77L, false)))
        .isInstanceOf(ForbiddenException.class);
    task.cancel();
    assertThatThrownBy(() -> DocumentStateMachine.requireDecidable(document, task, principal))
        .isInstanceOf(ConflictException.class);
  }

  @Test
  void aDecisionOnAStaleRoundIsAConflict() {
    DocumentStateMachine.submit(document, new Principal(OWNER, false), NOW);
    var step = definition.stepsAt(1).get(0);
    var staleTask = new ApprovalTask(document, 0, step, approver, NOW);
    var principal = new Principal(APPROVER, false);

    assertThatThrownBy(() -> DocumentStateMachine.requireDecidable(document, staleTask, principal))
        .isInstanceOf(ConflictException.class);
  }

  @Test
  void aDecisionOutsideReviewIsAnInvalidTransition() {
    var step = definition.stepsAt(1).get(0);
    var task = new ApprovalTask(document, 1, step, approver, NOW);

    assertThatThrownBy(
            () ->
                DocumentStateMachine.requireDecidable(
                    document, task, new Principal(APPROVER, false)))
        .isInstanceOf(InvalidTransitionException.class);
  }
}
