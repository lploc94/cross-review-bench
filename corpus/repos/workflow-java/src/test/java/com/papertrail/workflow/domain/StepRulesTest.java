package com.papertrail.workflow.domain;

import static com.papertrail.workflow.domain.StepRules.Outcome.APPROVED;
import static com.papertrail.workflow.domain.StepRules.Outcome.OPEN;
import static com.papertrail.workflow.domain.StepRules.Outcome.REJECTED;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

class StepRulesTest {

  @Test
  void aSingleApproverDecidesTheStep() {
    assertThat(StepRules.evaluate(StepKind.SINGLE, 0, 1, 0, 0)).isEqualTo(OPEN);
    assertThat(StepRules.evaluate(StepKind.SINGLE, 0, 1, 1, 0)).isEqualTo(APPROVED);
    assertThat(StepRules.evaluate(StepKind.SINGLE, 0, 1, 0, 1)).isEqualTo(REJECTED);
  }

  @Test
  void theFirstApprovalWinsAnyOfAGroup() {
    assertThat(StepRules.evaluate(StepKind.ANY_OF, 0, 3, 1, 0)).isEqualTo(APPROVED);
    assertThat(StepRules.evaluate(StepKind.ANY_OF, 0, 3, 0, 0)).isEqualTo(OPEN);
  }

  @Test
  void aRejectionEndsAnyOfAGroupAtOnce() {
    assertThat(StepRules.evaluate(StepKind.ANY_OF, 0, 3, 0, 1)).isEqualTo(REJECTED);
  }

  @ParameterizedTest
  @CsvSource({"0,0,OPEN", "1,0,OPEN", "2,0,OPEN", "3,0,APPROVED", "1,1,REJECTED"})
  void allOfNeedsEveryMemberToApprove(int approvals, int rejections, String expected) {
    assertThat(StepRules.evaluate(StepKind.ALL_OF, 0, 3, approvals, rejections))
        .isEqualTo(StepRules.Outcome.valueOf(expected));
  }

  @ParameterizedTest
  @CsvSource({"0,0,OPEN", "1,0,OPEN", "2,0,APPROVED", "3,0,APPROVED", "0,1,OPEN", "0,2,REJECTED"})
  void quorumApprovesAtTheThresholdAndRejectsWhenUnreachable(
      int approvals, int rejections, String expected) {
    assertThat(StepRules.evaluate(StepKind.QUORUM, 2, 3, approvals, rejections))
        .isEqualTo(StepRules.Outcome.valueOf(expected));
  }

  @Test
  void aStepWithoutApproversCannotBeActivated() {
    assertThatThrownBy(() -> StepRules.requireAssignable(StepKind.ANY_OF, 0, 0))
        .isInstanceOf(ValidationException.class);
  }

  @Test
  void aQuorumLargerThanTheGroupCannotBeActivated() {
    assertThatThrownBy(() -> StepRules.requireAssignable(StepKind.QUORUM, 3, 2))
        .isInstanceOf(ValidationException.class);
    StepRules.requireAssignable(StepKind.QUORUM, 2, 2);
  }
}
