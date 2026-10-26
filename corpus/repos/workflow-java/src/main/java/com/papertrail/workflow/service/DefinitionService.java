package com.papertrail.workflow.service;

import com.papertrail.workflow.domain.AppUser;
import com.papertrail.workflow.domain.ConflictException;
import com.papertrail.workflow.domain.NotFoundException;
import com.papertrail.workflow.domain.StepDefinition;
import com.papertrail.workflow.domain.UserGroup;
import com.papertrail.workflow.domain.WorkflowDefinition;
import com.papertrail.workflow.persistence.AppUserRepository;
import com.papertrail.workflow.persistence.UserGroupRepository;
import com.papertrail.workflow.persistence.WorkflowDefinitionRepository;
import com.papertrail.workflow.service.Views.DefinitionView;
import java.time.Clock;
import java.util.List;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** Creates, publishes and reads workflow definitions. Each name counts its own versions. */
@Service
public class DefinitionService {

  private final WorkflowDefinitionRepository definitions;
  private final AppUserRepository users;
  private final UserGroupRepository groups;
  private final Clock clock;

  public DefinitionService(
      WorkflowDefinitionRepository definitions,
      AppUserRepository users,
      UserGroupRepository groups,
      Clock clock) {
    this.definitions = definitions;
    this.users = users;
    this.groups = groups;
    this.clock = clock;
  }

  @Transactional
  public long createDraft(String name, List<StepSpec> steps) {
    int version = definitions.findMaxVersion(name.trim()).orElse(0) + 1;
    WorkflowDefinition definition = new WorkflowDefinition(name, version, clock.instant());
    for (StepSpec step : steps) {
      AppUser assignee = step.assigneeId() == null ? null : requireUser(step.assigneeId());
      UserGroup group = step.groupId() == null ? null : requireGroup(step.groupId());
      definition.addStep(
          step.order(), step.kind(), assignee, group, step.quorum(), step.slaMinutes());
    }
    return definitions.save(definition).getId();
  }

  @Transactional
  public void publish(long definitionId) {
    get(definitionId).publish(clock.instant());
  }

  @Transactional(readOnly = true)
  public DefinitionView view(long definitionId) {
    return DefinitionView.of(get(definitionId));
  }

  /** Published definitions, or only the versions of one name when a name is given. */
  @Transactional(readOnly = true)
  public List<DefinitionView> listPublished(String name) {
    List<WorkflowDefinition> rows =
        name == null || name.isBlank()
            ? definitions.findByPublishedTrueOrderByNameAscVersionAsc()
            : definitions.findByPublishedTrueAndNameOrderByVersionAsc(name.trim());
    return rows.stream().map(DefinitionView::of).toList();
  }

  /** One published version for signed-in users; a draft is a 404 here, as on the list. */
  @Transactional(readOnly = true)
  public DefinitionView viewPublished(long definitionId) {
    WorkflowDefinition definition = get(definitionId);
    if (!definition.isPublished()) {
      throw new NotFoundException("definition not found");
    }
    return DefinitionView.of(definition);
  }

  /** Every version, drafts included, for one name or for all names. */
  @Transactional(readOnly = true)
  public List<DefinitionView> listAll(String name) {
    List<WorkflowDefinition> rows =
        name == null || name.isBlank()
            ? definitions.findAllByOrderByNameAscVersionAsc()
            : definitions.findByNameOrderByVersionAsc(name.trim());
    return rows.stream().map(DefinitionView::of).toList();
  }

  /** Adds a step to a draft; a published definition refuses it in the entity. */
  @Transactional
  public void addStep(long definitionId, StepSpec step) {
    addStepTo(get(definitionId), step);
  }

  /** Replaces a draft's step: the old one goes, the new one is added with its own order. */
  @Transactional
  public void replaceStep(long definitionId, long stepId, StepSpec step) {
    WorkflowDefinition definition = get(definitionId);
    definition.removeStep(stepId);
    addStepTo(definition, step);
  }

  /** Removes a step from a draft. */
  @Transactional
  public void removeStep(long definitionId, long stepId) {
    get(definitionId).removeStep(stepId);
  }

  /**
   * Starts the next version of a published definition: a draft under the same name that copies its
   * steps. The published version stays as it was, for the documents that started on it.
   */
  @Transactional
  public long revise(long definitionId) {
    WorkflowDefinition published = get(definitionId);
    if (!published.isPublished()) {
      throw new ConflictException("only a published definition can be revised");
    }
    int version = definitions.findMaxVersion(published.getName()).orElse(0) + 1;
    WorkflowDefinition draft =
        new WorkflowDefinition(published.getName(), version, clock.instant());
    for (StepDefinition step : published.getSteps()) {
      draft.addStep(
          step.getStepOrder(),
          step.getKind(),
          step.getAssignee(),
          step.getGroup(),
          step.getQuorum(),
          (int) step.getSla().toMinutes());
    }
    return definitions.save(draft).getId();
  }

  private void addStepTo(WorkflowDefinition definition, StepSpec step) {
    AppUser assignee = step.assigneeId() == null ? null : requireUser(step.assigneeId());
    UserGroup group = step.groupId() == null ? null : requireGroup(step.groupId());
    definition.addStep(
        step.order(), step.kind(), assignee, group, step.quorum(), step.slaMinutes());
  }

  /** Deletes a draft. A published version is part of the record of documents that used it. */
  @Transactional
  public void discardDraft(long definitionId) {
    WorkflowDefinition definition = get(definitionId);
    if (definition.isPublished()) {
      throw new ConflictException("a published definition cannot be discarded");
    }
    definitions.delete(definition);
  }

  private WorkflowDefinition get(long definitionId) {
    return definitions
        .findById(definitionId)
        .orElseThrow(() -> new NotFoundException("definition not found"));
  }

  private AppUser requireUser(long userId) {
    return users.findById(userId).orElseThrow(() -> new NotFoundException("user not found"));
  }

  private UserGroup requireGroup(long groupId) {
    return groups.findById(groupId).orElseThrow(() -> new NotFoundException("group not found"));
  }
}
