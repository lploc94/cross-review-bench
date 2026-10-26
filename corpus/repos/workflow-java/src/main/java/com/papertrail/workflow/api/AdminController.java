package com.papertrail.workflow.api;

import com.papertrail.workflow.api.dto.Requests.CreateDefinitionRequest;
import com.papertrail.workflow.api.dto.Requests.CreateGroupRequest;
import com.papertrail.workflow.api.dto.Requests.CreateStepRequest;
import com.papertrail.workflow.api.dto.Requests.CreateUserRequest;
import com.papertrail.workflow.api.dto.Requests.UpdateUserRequest;
import com.papertrail.workflow.api.dto.Responses.CountResponse;
import com.papertrail.workflow.api.dto.Responses.IdResponse;
import com.papertrail.workflow.api.dto.Responses.JobRunResponse;
import com.papertrail.workflow.api.dto.Responses.TokenResponse;
import com.papertrail.workflow.domain.OutboxStatus;
import com.papertrail.workflow.integration.OutboxDispatchJob;
import com.papertrail.workflow.integration.OutboxDispatcher.DispatchResult;
import com.papertrail.workflow.integration.SlaEscalationJob;
import com.papertrail.workflow.service.DefinitionService;
import com.papertrail.workflow.service.IdentityService;
import com.papertrail.workflow.service.OperatorSummary;
import com.papertrail.workflow.service.OutboxService;
import com.papertrail.workflow.service.StepSpec;
import com.papertrail.workflow.service.TaskQueries;
import com.papertrail.workflow.service.Views.AuditView;
import com.papertrail.workflow.service.Views.DefinitionView;
import com.papertrail.workflow.service.Views.GroupView;
import com.papertrail.workflow.service.Views.OutboxView;
import com.papertrail.workflow.service.Views.PageView;
import com.papertrail.workflow.service.Views.SummaryView;
import com.papertrail.workflow.service.Views.TaskView;
import com.papertrail.workflow.service.Views.TokenView;
import com.papertrail.workflow.service.Views.UserView;
import jakarta.validation.Valid;
import java.net.URI;
import java.util.List;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** Operator routes, behind the admin token: identity, definitions and the background jobs. */
@RestController
@RequestMapping("/api/v1/admin")
public class AdminController {

  private final IdentityService identity;
  private final DefinitionService definitions;
  private final OutboxService outbox;
  private final TaskQueries tasks;
  private final OperatorSummary summary;
  private final SlaEscalationJob escalation;
  private final OutboxDispatchJob dispatch;

  public AdminController(
      IdentityService identity,
      DefinitionService definitions,
      OutboxService outbox,
      TaskQueries tasks,
      OperatorSummary summary,
      SlaEscalationJob escalation,
      OutboxDispatchJob dispatch) {
    this.identity = identity;
    this.definitions = definitions;
    this.outbox = outbox;
    this.tasks = tasks;
    this.summary = summary;
    this.escalation = escalation;
    this.dispatch = dispatch;
  }

  @PostMapping("/users")
  public ResponseEntity<IdResponse> createUser(@Valid @RequestBody CreateUserRequest request) {
    long id = identity.createUser(request.displayName(), request.email(), request.admin());
    return ResponseEntity.created(URI.create("/api/v1/admin/users/" + id)).body(new IdResponse(id));
  }

  @GetMapping("/users/{id}")
  public UserView user(@PathVariable long id) {
    return identity.view(id);
  }

  @GetMapping("/users")
  public PageView<UserView> users(
      @RequestParam(required = false) Boolean active,
      @RequestParam(required = false) Long cursor,
      @RequestParam(required = false) Integer size) {
    return identity.users(active, cursor, size);
  }

  @PatchMapping("/users/{id}")
  public UserView updateUser(@PathVariable long id, @Valid @RequestBody UpdateUserRequest request) {
    return identity.updateUser(id, request.displayName(), request.email(), request.active());
  }

  @PostMapping("/users/{id}/tokens/revoke")
  public ResponseEntity<Void> revokeAllTokens(@PathVariable long id) {
    identity.revokeAllTokens(id);
    return ResponseEntity.noContent().build();
  }

  @GetMapping("/users/{id}/tokens")
  public List<TokenView> tokens(@PathVariable long id) {
    return identity.tokensOf(id);
  }

  @PostMapping("/users/{id}/tokens")
  public ResponseEntity<TokenResponse> issueToken(@PathVariable long id) {
    return ResponseEntity.status(201).body(new TokenResponse(identity.issueToken(id)));
  }

  @PostMapping("/tokens/{prefix}/revoke")
  public ResponseEntity<Void> revokeToken(@PathVariable String prefix) {
    identity.revokeToken(prefix);
    return ResponseEntity.noContent().build();
  }

  @PostMapping("/groups")
  public ResponseEntity<IdResponse> createGroup(@Valid @RequestBody CreateGroupRequest request) {
    long id = identity.createGroup(request.name());
    return ResponseEntity.created(URI.create("/api/v1/admin/groups/" + id))
        .body(new IdResponse(id));
  }

  @GetMapping("/groups")
  public List<GroupView> groups() {
    return identity.groups();
  }

  @GetMapping("/groups/{id}")
  public GroupView group(@PathVariable long id) {
    return identity.group(id);
  }

  @PatchMapping("/groups/{id}")
  public GroupView renameGroup(
      @PathVariable long id, @Valid @RequestBody CreateGroupRequest request) {
    return identity.renameGroup(id, request.name());
  }

  @DeleteMapping("/groups/{id}")
  public ResponseEntity<Void> deleteGroup(@PathVariable long id) {
    identity.deleteGroup(id);
    return ResponseEntity.noContent().build();
  }

  @PutMapping("/groups/{groupId}/members/{userId}")
  public ResponseEntity<Void> addMember(@PathVariable long groupId, @PathVariable long userId) {
    identity.addMember(groupId, userId);
    return ResponseEntity.noContent().build();
  }

  @DeleteMapping("/groups/{groupId}/members/{userId}")
  public ResponseEntity<Void> removeMember(@PathVariable long groupId, @PathVariable long userId) {
    identity.removeMember(groupId, userId);
    return ResponseEntity.noContent().build();
  }

  @PostMapping("/definitions")
  public ResponseEntity<IdResponse> createDefinition(
      @Valid @RequestBody CreateDefinitionRequest request) {
    List<StepSpec> steps = request.steps().stream().map(AdminController::toSpec).toList();
    long id = definitions.createDraft(request.name(), steps);
    return ResponseEntity.created(URI.create("/api/v1/admin/definitions/" + id))
        .body(new IdResponse(id));
  }

  @GetMapping("/definitions/{id}")
  public DefinitionView definition(@PathVariable long id) {
    return definitions.view(id);
  }

  @GetMapping("/users/{id}/tasks")
  public List<TaskView> tasksOf(@PathVariable long id) {
    identity.view(id);
    return tasks.openOf(id);
  }

  @GetMapping("/definitions")
  public List<DefinitionView> definitions(@RequestParam(required = false) String name) {
    return definitions.listAll(name);
  }

  @PostMapping("/definitions/{id}/steps")
  public DefinitionView addStep(
      @PathVariable long id, @Valid @RequestBody CreateStepRequest request) {
    definitions.addStep(id, toSpec(request));
    return definitions.view(id);
  }

  @PutMapping("/definitions/{id}/steps/{stepId}")
  public DefinitionView replaceStep(
      @PathVariable long id,
      @PathVariable long stepId,
      @Valid @RequestBody CreateStepRequest request) {
    definitions.replaceStep(id, stepId, toSpec(request));
    return definitions.view(id);
  }

  @PostMapping("/definitions/{id}/revise")
  public ResponseEntity<IdResponse> revise(@PathVariable long id) {
    long draft = definitions.revise(id);
    return ResponseEntity.created(URI.create("/api/v1/admin/definitions/" + draft))
        .body(new IdResponse(draft));
  }

  @DeleteMapping("/definitions/{id}/steps/{stepId}")
  public DefinitionView removeStep(@PathVariable long id, @PathVariable long stepId) {
    definitions.removeStep(id, stepId);
    return definitions.view(id);
  }

  @DeleteMapping("/definitions/{id}")
  public ResponseEntity<Void> discardDraft(@PathVariable long id) {
    definitions.discardDraft(id);
    return ResponseEntity.noContent().build();
  }

  @PostMapping("/definitions/{id}/publish")
  public DefinitionView publish(@PathVariable long id) {
    definitions.publish(id);
    return definitions.view(id);
  }

  @GetMapping("/outbox")
  public PageView<OutboxView> outbox(
      @RequestParam(required = false) OutboxStatus status,
      @RequestParam(required = false) Long cursor,
      @RequestParam(required = false) Integer size) {
    return outbox.list(status, cursor, size);
  }

  @GetMapping("/outbox/{id}")
  public OutboxView outboxEvent(@PathVariable long id) {
    return outbox.get(id);
  }

  @PostMapping("/outbox/requeue-failed")
  public CountResponse requeueFailed() {
    return new CountResponse(outbox.requeueFailed());
  }

  @DeleteMapping("/outbox/{id}")
  public ResponseEntity<Void> discardOutbox(@PathVariable long id) {
    outbox.discard(id);
    return ResponseEntity.noContent().build();
  }

  @PostMapping("/outbox/{id}/requeue")
  public OutboxView requeue(@PathVariable long id) {
    return outbox.requeue(id);
  }

  @GetMapping("/audit")
  public PageView<AuditView> audit(
      @RequestParam(required = false) Long cursor, @RequestParam(required = false) Integer size) {
    return summary.auditTrail(cursor, size);
  }

  @GetMapping("/summary")
  public SummaryView summary() {
    return summary.summary();
  }

  @GetMapping("/tasks/overdue")
  public PageView<TaskView> overdue(
      @RequestParam(required = false) Long cursor, @RequestParam(required = false) Integer size) {
    return tasks.overdue(cursor, size);
  }

  /** Runs one escalation pass and one dispatch pass now, as the timers would. */
  @PostMapping("/jobs/run")
  public JobRunResponse runJobs() {
    int escalated = escalation.runOnce();
    DispatchResult result = dispatch.runOnce();
    return new JobRunResponse(escalated, result.sent(), result.failed());
  }

  private static StepSpec toSpec(CreateStepRequest step) {
    return new StepSpec(
        step.order(),
        step.kind(),
        step.assigneeId(),
        step.groupId(),
        step.quorum(),
        step.slaMinutes());
  }
}
