package com.papertrail.workflow.service;

import com.papertrail.workflow.domain.AppUser;
import com.papertrail.workflow.domain.Document;
import com.papertrail.workflow.domain.DocumentPermission;
import com.papertrail.workflow.domain.DocumentStateMachine;
import com.papertrail.workflow.domain.NotFoundException;
import com.papertrail.workflow.domain.PermissionLevel;
import com.papertrail.workflow.domain.Principal;
import com.papertrail.workflow.domain.ValidationException;
import com.papertrail.workflow.persistence.AppUserRepository;
import com.papertrail.workflow.persistence.DocumentPermissionRepository;
import com.papertrail.workflow.service.Views.PermissionView;
import java.time.Clock;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Explicit grants on one document. Only its owner or an admin changes them; every change is
 * audited.
 */
@Service
public class PermissionService {

  private final DocumentPermissionRepository permissions;
  private final AppUserRepository users;
  private final DocumentAccess access;
  private final EventLog events;
  private final Clock clock;

  public PermissionService(
      DocumentPermissionRepository permissions,
      AppUserRepository users,
      DocumentAccess access,
      EventLog events,
      Clock clock) {
    this.permissions = permissions;
    this.users = users;
    this.access = access;
    this.events = events;
    this.clock = clock;
  }

  @Transactional
  public void grant(Principal actor, long documentId, long userId, PermissionLevel level) {
    Document document = access.lockVisible(actor, documentId);
    DocumentStateMachine.requireManager(document, actor);
    AppUser target =
        users.findById(userId).orElseThrow(() -> new NotFoundException("user not found"));
    if (!target.isActive()) {
      throw new ValidationException("an inactive user cannot be granted access");
    }
    if (document.isOwnedBy(userId)) {
      throw new ValidationException("the owner already has access");
    }
    Instant now = clock.instant();
    permissions
        .findByDocumentIdAndUserId(documentId, userId)
        .ifPresentOrElse(
            existing -> existing.changeLevel(level, now),
            () -> permissions.save(new DocumentPermission(document, target, level, now)));
    events.audit(
        document,
        actor.userId(),
        "PERMISSION_GRANTED",
        Map.of("userId", userId, "level", level.name()),
        now);
  }

  @Transactional
  public void revoke(Principal actor, long documentId, long userId) {
    Document document = access.lockVisible(actor, documentId);
    DocumentStateMachine.requireManager(document, actor);
    DocumentPermission permission =
        permissions
            .findByDocumentIdAndUserId(documentId, userId)
            .orElseThrow(() -> new NotFoundException("no such grant"));
    permissions.delete(permission);
    events.audit(
        document, actor.userId(), "PERMISSION_REVOKED", Map.of("userId", userId), clock.instant());
  }

  @Transactional(readOnly = true)
  public List<PermissionView> list(Principal actor, long documentId) {
    access.visible(actor, documentId);
    return permissions.findForDocument(documentId).stream().map(PermissionView::of).toList();
  }
}
