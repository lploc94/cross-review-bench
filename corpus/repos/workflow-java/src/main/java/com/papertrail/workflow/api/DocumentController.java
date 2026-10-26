package com.papertrail.workflow.api;

import com.papertrail.workflow.api.dto.Requests.CreateDocumentRequest;
import com.papertrail.workflow.api.dto.Requests.UpdateDocumentRequest;
import com.papertrail.workflow.api.dto.Responses.CountResponse;
import com.papertrail.workflow.api.dto.Responses.IdResponse;
import com.papertrail.workflow.domain.DocumentStatus;
import com.papertrail.workflow.domain.Principal;
import com.papertrail.workflow.persistence.DocumentFilter;
import com.papertrail.workflow.service.DocumentService;
import com.papertrail.workflow.service.TaskQueries;
import com.papertrail.workflow.service.Views.AccessView;
import com.papertrail.workflow.service.Views.AuditView;
import com.papertrail.workflow.service.Views.DocumentDetail;
import com.papertrail.workflow.service.Views.DocumentSummary;
import com.papertrail.workflow.service.Views.PageView;
import com.papertrail.workflow.service.Views.RoundView;
import jakarta.validation.Valid;
import java.net.URI;
import java.util.List;
import java.util.Map;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** Documents the caller can see, and the owner's lifecycle moves on them. */
@RestController
@RequestMapping("/api/v1/documents")
public class DocumentController {

  private final DocumentService documents;
  private final TaskQueries tasks;
  private final CurrentPrincipal current;

  public DocumentController(
      DocumentService documents, TaskQueries tasks, CurrentPrincipal current) {
    this.documents = documents;
    this.tasks = tasks;
    this.current = current;
  }

  @PostMapping
  public ResponseEntity<IdResponse> create(@Valid @RequestBody CreateDocumentRequest request) {
    long id =
        documents.create(principal(), request.title(), request.body(), request.definitionName());
    return ResponseEntity.created(URI.create("/api/v1/documents/" + id)).body(new IdResponse(id));
  }

  @GetMapping
  public PageView<DocumentSummary> list(
      @RequestParam(required = false) DocumentStatus status,
      @RequestParam(required = false) Long owner,
      @RequestParam(required = false) String definition,
      @RequestParam(required = false) Boolean shared,
      @RequestParam(required = false) Long cursor,
      @RequestParam(required = false) Integer size) {
    DocumentFilter filter =
        new DocumentFilter(status, owner, definition, Boolean.TRUE.equals(shared));
    return documents.list(principal(), filter, cursor, size);
  }

  /** Every round of the document with its tasks, so earlier decisions stay on record. */
  @GetMapping("/{id}/rounds")
  public List<RoundView> rounds(@PathVariable long id) {
    return tasks.rounds(principal(), id);
  }

  @GetMapping("/count")
  public CountResponse count(
      @RequestParam(required = false) DocumentStatus status,
      @RequestParam(required = false) Long owner,
      @RequestParam(required = false) String definition) {
    return new CountResponse(
        documents.count(principal(), new DocumentFilter(status, owner, definition)));
  }

  @GetMapping("/{id}")
  public DocumentDetail get(@PathVariable long id) {
    return documents.get(principal(), id);
  }

  @PutMapping("/{id}")
  public ResponseEntity<Void> updateDraft(
      @PathVariable long id, @Valid @RequestBody UpdateDocumentRequest request) {
    documents.updateDraft(principal(), id, request.title(), request.body());
    return ResponseEntity.noContent().build();
  }

  @PostMapping("/{id}/submit")
  public ResponseEntity<Void> submit(@PathVariable long id) {
    documents.submit(principal(), id);
    return ResponseEntity.noContent().build();
  }

  @PostMapping("/{id}/resubmit")
  public ResponseEntity<Void> resubmit(@PathVariable long id) {
    documents.resubmit(principal(), id);
    return ResponseEntity.noContent().build();
  }

  @PostMapping("/{id}/withdraw")
  public ResponseEntity<Void> withdraw(@PathVariable long id) {
    documents.withdraw(principal(), id);
    return ResponseEntity.noContent().build();
  }

  @GetMapping("/{id}/audit")
  public PageView<AuditView> audit(
      @PathVariable long id,
      @RequestParam(required = false) Long cursor,
      @RequestParam(required = false) Integer size) {
    return documents.audit(principal(), id, cursor, size);
  }

  @GetMapping("/{id}/access")
  public AccessView access(@PathVariable long id) {
    return documents.who(principal(), id);
  }

  @GetMapping("/summary")
  public Map<DocumentStatus, Long> summary() {
    return documents.summary(principal());
  }

  private Principal principal() {
    return current.require();
  }
}
