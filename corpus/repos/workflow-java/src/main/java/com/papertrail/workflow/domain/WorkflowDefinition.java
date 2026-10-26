package com.papertrail.workflow.domain;

import jakarta.persistence.CascadeType;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.OneToMany;
import jakarta.persistence.OrderBy;
import jakarta.persistence.Table;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.OptionalInt;

/**
 * A versioned approval route. A draft takes steps; publishing freezes it, and each document keeps
 * the version it started with, so later edits never move a running review.
 */
@Entity
@Table(name = "workflow_definition")
public class WorkflowDefinition extends AbstractEntity<Long> {

  @Id
  @GeneratedValue(strategy = GenerationType.IDENTITY)
  private Long id;

  @Column(nullable = false, length = 80)
  private String name;

  @Column(nullable = false)
  private int version;

  @Column(nullable = false)
  private boolean published;

  @Column(name = "created_at", nullable = false)
  private Instant createdAt;

  @Column(name = "published_at")
  private Instant publishedAt;

  @OneToMany(mappedBy = "definition", cascade = CascadeType.ALL, orphanRemoval = true)
  @OrderBy("stepOrder ASC, id ASC")
  private List<StepDefinition> steps = new ArrayList<>();

  protected WorkflowDefinition() {}

  public WorkflowDefinition(String name, int version, Instant createdAt) {
    this.name = AppUser.requireText(name, "name", 80);
    this.version = version;
    this.createdAt = createdAt;
  }

  /** Adds a step to a draft. Parallel steps share a {@code stepOrder}. */
  public StepDefinition addStep(
      int stepOrder, StepKind kind, AppUser assignee, UserGroup group, int quorum, int slaMinutes) {
    requireDraft();
    StepDefinition step =
        new StepDefinition(this, stepOrder, kind, assignee, group, quorum, slaMinutes);
    steps.add(step);
    return step;
  }

  /** Freezes the definition. It must have at least one step and must not be published yet. */
  public void publish(Instant now) {
    requireDraft();
    if (steps.isEmpty()) {
      throw new ValidationException("a definition needs at least one step before it is published");
    }
    this.published = true;
    this.publishedAt = now;
  }

  /** The lowest step order, where a review starts. */
  public int firstOrder() {
    return steps.stream().mapToInt(StepDefinition::getStepOrder).min().orElseThrow();
  }

  /** The next step order after {@code order}, if any. */
  public OptionalInt nextOrderAfter(int order) {
    return steps.stream()
        .mapToInt(StepDefinition::getStepOrder)
        .filter(value -> value > order)
        .min();
  }

  /** The steps of one order, in definition order. */
  public List<StepDefinition> stepsAt(int order) {
    return steps.stream()
        .filter(step -> step.getStepOrder() == order)
        .sorted(Comparator.comparingLong(step -> step.getId() == null ? 0L : step.getId()))
        .toList();
  }

  private void requireDraft() {
    if (published) {
      throw new ConflictException("definition " + name + " v" + version + " is published");
    }
  }

  @Override
  public Long getId() {
    return id;
  }

  public String getName() {
    return name;
  }

  public int getVersion() {
    return version;
  }

  public boolean isPublished() {
    return published;
  }

  public Instant getCreatedAt() {
    return createdAt;
  }

  public Instant getPublishedAt() {
    return publishedAt;
  }

  public List<StepDefinition> getSteps() {
    return steps.stream().sorted(Comparator.comparingInt(StepDefinition::getStepOrder)).toList();
  }

  /** Removes a step from a draft. Its assignments go with it. */
  public void removeStep(long stepId) {
    requireDraft();
    boolean removed = steps.removeIf(step -> step.getId() != null && step.getId() == stepId);
    if (!removed) {
      throw new NotFoundException("step not found");
    }
  }
}
