package com.papertrail.workflow.domain;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Instant;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.springframework.test.util.ReflectionTestUtils;

class WorkflowDefinitionTest {

  private static final Instant NOW = Instant.parse("2027-05-03T10:00:00Z");

  private final AppUser approver = new AppUser("Ines Berg", "ines@example.com", false);
  private final UserGroup finance = new UserGroup("finance");

  @Test
  void aPublishedDefinitionCannotChange() {
    WorkflowDefinition definition = new WorkflowDefinition("Expenses", 1, NOW);
    definition.addStep(1, StepKind.SINGLE, approver, null, 0, 480);
    definition.publish(NOW);

    assertThatThrownBy(() -> definition.addStep(2, StepKind.SINGLE, approver, null, 0, 480))
        .isInstanceOf(ConflictException.class);
    assertThatThrownBy(() -> definition.publish(NOW)).isInstanceOf(ConflictException.class);
  }

  @Test
  void aDefinitionNeedsAStepBeforePublishing() {
    WorkflowDefinition definition = new WorkflowDefinition("Expenses", 1, NOW);

    assertThatThrownBy(() -> definition.publish(NOW)).isInstanceOf(ValidationException.class);
  }

  @Test
  void stepsAreReadInOrderAndNextOrderSkipsParallelSteps() {
    WorkflowDefinition definition = new WorkflowDefinition("Contract", 1, NOW);
    definition.addStep(2, StepKind.SINGLE, approver, null, 0, 60);
    definition.addStep(1, StepKind.ANY_OF, null, finance, 0, 60);
    definition.addStep(1, StepKind.SINGLE, approver, null, 0, 120);
    definition.publish(NOW);

    assertThat(definition.getSteps())
        .extracting(StepDefinition::getStepOrder)
        .containsExactly(1, 1, 2);
    assertThat(definition.firstOrder()).isEqualTo(1);
    assertThat(definition.nextOrderAfter(1).getAsInt()).isEqualTo(2);
    assertThat(definition.nextOrderAfter(2).isPresent()).isFalse();
    assertThat(definition.stepsAt(1)).hasSize(2);
  }

  @Test
  void aSingleStepNamesOneApproverAndNoGroup() {
    assertThatThrownBy(
            () ->
                new WorkflowDefinition("X", 1, NOW).addStep(1, StepKind.SINGLE, null, null, 0, 60))
        .isInstanceOf(ValidationException.class);
    assertThatThrownBy(
            () ->
                new WorkflowDefinition("X", 1, NOW)
                    .addStep(1, StepKind.SINGLE, approver, finance, 0, 60))
        .isInstanceOf(ValidationException.class);
  }

  @Test
  void aGroupStepNamesAGroupAndNoApprover() {
    assertThatThrownBy(
            () ->
                new WorkflowDefinition("X", 1, NOW)
                    .addStep(1, StepKind.ALL_OF, approver, finance, 0, 60))
        .isInstanceOf(ValidationException.class);
    assertThatThrownBy(
            () ->
                new WorkflowDefinition("X", 1, NOW)
                    .addStep(1, StepKind.ALL_OF, null, finance, 2, 60))
        .isInstanceOf(ValidationException.class);
  }

  @Test
  void aQuorumStepNeedsAGroupAndAPositiveQuorum() {
    assertThatThrownBy(
            () ->
                new WorkflowDefinition("X", 1, NOW)
                    .addStep(1, StepKind.QUORUM, null, finance, 0, 60))
        .isInstanceOf(ValidationException.class);
    new WorkflowDefinition("X", 1, NOW).addStep(1, StepKind.QUORUM, null, finance, 2, 60);
  }

  @ParameterizedTest
  @CsvSource({"0, 60", "101, 60", "1, 0", "1, 43201"})
  void stepOrderAndSlaAreBounded(int order, int slaMinutes) {
    assertThatThrownBy(
            () ->
                new WorkflowDefinition("X", 1, NOW)
                    .addStep(order, StepKind.SINGLE, approver, null, 0, slaMinutes))
        .isInstanceOf(ValidationException.class);
  }

  @Test
  void theDefinitionNameIsTrimmedAndMustNotBeBlank() {
    assertThat(new WorkflowDefinition("  Expenses  ", 1, NOW).getName()).isEqualTo("Expenses");
    assertThatThrownBy(() -> new WorkflowDefinition("   ", 1, NOW))
        .isInstanceOf(ValidationException.class);
  }

  @Test
  void aDocumentStartsOnlyFromAPublishedDefinition() {
    WorkflowDefinition draft = new WorkflowDefinition("Expenses", 1, NOW);
    draft.addStep(1, StepKind.SINGLE, approver, null, 0, 60);

    assertThatThrownBy(() -> Document.draft(approver, draft, "Claim", "Body", NOW))
        .isInstanceOf(ValidationException.class);
  }

  @Test
  void aStepExposesItsSlaAsADuration() {
    WorkflowDefinition definition = new WorkflowDefinition("X", 1, NOW);
    StepDefinition step = definition.addStep(1, StepKind.SINGLE, approver, null, 0, 90);

    assertThat(step.getSla().toMinutes()).isEqualTo(90);
    ReflectionTestUtils.setField(step, "id", 5L);
    assertThat(step.getId()).isEqualTo(5L);
  }
}
