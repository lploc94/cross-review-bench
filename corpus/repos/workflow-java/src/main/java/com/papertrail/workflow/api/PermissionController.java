package com.papertrail.workflow.api;

import com.papertrail.workflow.api.dto.Requests.GrantPermissionRequest;
import com.papertrail.workflow.service.PermissionService;
import com.papertrail.workflow.service.Views.PermissionView;
import jakarta.validation.Valid;
import java.util.List;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** Who else may see a document, granted by its owner. */
@RestController
@RequestMapping("/api/v1/documents/{documentId}/permissions")
public class PermissionController {

  private final PermissionService permissions;
  private final CurrentPrincipal current;

  public PermissionController(PermissionService permissions, CurrentPrincipal current) {
    this.permissions = permissions;
    this.current = current;
  }

  @GetMapping
  public List<PermissionView> list(@PathVariable long documentId) {
    return permissions.list(current.require(), documentId);
  }

  @PutMapping("/{userId}")
  public ResponseEntity<Void> grant(
      @PathVariable long documentId,
      @PathVariable long userId,
      @Valid @RequestBody GrantPermissionRequest request) {
    permissions.grant(current.require(), documentId, userId, request.level());
    return ResponseEntity.noContent().build();
  }

  @DeleteMapping("/{userId}")
  public ResponseEntity<Void> revoke(@PathVariable long documentId, @PathVariable long userId) {
    permissions.revoke(current.require(), documentId, userId);
    return ResponseEntity.noContent().build();
  }
}
