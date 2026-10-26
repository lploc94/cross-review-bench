package com.papertrail.workflow.domain;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.FetchType;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.JoinColumn;
import jakarta.persistence.ManyToOne;
import jakarta.persistence.Table;
import java.time.Duration;

/** One step of a definition: who decides, how, and how long they have. */
@Entity
@Table(name = "step_definition")
public class StepDefinition extends AbstractEntity<Long> {

  static final int MAX_STEP_ORDER = 100;
  static final int MAX_SLA_MINUTES = 60 * 24 * 30;

  @Id
  @GeneratedValue(strategy = GenerationType.IDENTITY)
  private Long id;

  @ManyToOne(fetch = FetchType.LAZY, optional = false)
  @JoinColumn(name = "definition_id", nullable = false)
  private WorkflowDefinition definition;

  @Column(name = "step_order", nullable = false)
  private int stepOrder;

  @Enumerated(EnumType.STRING)
  @Column(nullable = false, length = 16)
  private StepKind kind;

  @ManyToOne(fetch = FetchType.LAZY)
  @JoinColumn(name = "assignee_id")
  private AppUser assignee;

  @ManyToOne(fetch = FetchType.LAZY)
  @JoinColumn(name = "group_id")
  private UserGroup group;

  @Column(nullable = false)
  private int quorum;

  @Column(name = "sla_minutes", nullable = false)
  private int slaMinutes;

  protected StepDefinition() {}

  StepDefinition(
      WorkflowDefinition definition,
      int stepOrder,
      StepKind kind,
      AppUser assignee,
      UserGroup group,
      int quorum,
      int slaMinutes) {
    if (stepOrder < 1 || stepOrder > MAX_STEP_ORDER) {
      throw new ValidationException("stepOrder must be between 1 and " + MAX_STEP_ORDER);
    }
    if (slaMinutes < 1 || slaMinutes > MAX_SLA_MINUTES) {
      throw new ValidationException("slaMinutes must be between 1 and " + MAX_SLA_MINUTES);
    }
    if (kind == null) {
      throw new ValidationException("kind is required");
    }
    switch (kind) {
      case SINGLE -> {
        if (assignee == null || group != null || quorum != 0) {
          throw new ValidationException("a SINGLE step names one assignee and no group");
        }
      }
      case QUORUM -> {
        if (group == null || assignee != null || quorum < 1) {
          throw new ValidationException("a QUORUM step names a group and a quorum of at least 1");
        }
      }
      case ANY_OF, ALL_OF -> {
        if (group == null || assignee != null || quorum != 0) {
          throw new ValidationException(kind + " steps name a group and no assignee");
        }
      }
    }
    this.definition = definition;
    this.stepOrder = stepOrder;
    this.kind = kind;
    this.assignee = assignee;
    this.group = group;
    this.quorum = quorum;
    this.slaMinutes = slaMinutes;
  }

  @Override
  public Long getId() {
    return id;
  }

  public WorkflowDefinition getDefinition() {
    return definition;
  }

  public int getStepOrder() {
    return stepOrder;
  }

  public StepKind getKind() {
    return kind;
  }

  public AppUser getAssignee() {
    return assignee;
  }

  public UserGroup getGroup() {
    return group;
  }

  public int getQuorum() {
    return quorum;
  }

  public Duration getSla() {
    return Duration.ofMinutes(slaMinutes);
  }
}
