package com.papertrail.workflow.api;

import com.papertrail.workflow.api.dto.Requests.DecisionRequest;
import com.papertrail.workflow.api.dto.Responses.CountResponse;
import com.papertrail.workflow.domain.Principal;
import com.papertrail.workflow.service.ApprovalService;
import com.papertrail.workflow.service.TaskQueries;
import com.papertrail.workflow.service.Views.PageView;
import com.papertrail.workflow.service.Views.TaskView;
import jakarta.validation.Valid;
import java.util.List;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** The caller's approval work: open and finished tasks, one task, and recording a decision. */
@RestController
@RequestMapping("/api/v1/tasks")
public class TaskController {

  private final ApprovalService approvals;
  private final TaskQueries queries;
  private final CurrentPrincipal current;

  public TaskController(ApprovalService approvals, TaskQueries queries, CurrentPrincipal current) {
    this.approvals = approvals;
    this.queries = queries;
    this.current = current;
  }

  @GetMapping("/mine")
  public List<TaskView> mine() {
    return queries.openFor(current.require());
  }

  @GetMapping("/mine/count")
  public CountResponse countMine() {
    return new CountResponse(queries.countOpenFor(current.require()));
  }

  @GetMapping("/decided")
  public PageView<TaskView> decided(
      @RequestParam(required = false) Long cursor, @RequestParam(required = false) Integer size) {
    return queries.decidedFor(current.require(), cursor, size);
  }

  @GetMapping("/{id}")
  public TaskView get(@PathVariable long id) {
    return queries.get(current.require(), id);
  }

  @PostMapping("/{id}/decision")
  public TaskView decide(@PathVariable long id, @Valid @RequestBody DecisionRequest request) {
    Principal actor = current.require();
    return approvals.decide(actor, id, request.decision(), request.comment());
  }
}
