package com.papertrail.workflow.support;

import com.papertrail.workflow.domain.AppUser;
import com.papertrail.workflow.domain.Principal;
import com.papertrail.workflow.domain.StepKind;
import com.papertrail.workflow.persistence.AppUserRepository;
import com.papertrail.workflow.service.DefinitionService;
import com.papertrail.workflow.service.DocumentService;
import com.papertrail.workflow.service.IdentityService;
import com.papertrail.workflow.service.StepSpec;
import java.util.List;
import org.springframework.stereotype.Component;

/**
 * Builds invented users, groups, definitions and documents for the tests. Names are invented and
 * every address is at example.com.
 */
@Component
public class TestData {

  private final IdentityService identity;
  private final DefinitionService definitions;
  private final DocumentService documents;
  private final AppUserRepository users;

  public TestData(
      IdentityService identity,
      DefinitionService definitions,
      DocumentService documents,
      AppUserRepository users) {
    this.identity = identity;
    this.definitions = definitions;
    this.documents = documents;
    this.users = users;
  }

  public long user(String displayName) {
    return identity.createUser(displayName, slug(displayName) + "@example.com", false);
  }

  public long admin(String displayName) {
    return identity.createUser(displayName, slug(displayName) + "@example.com", true);
  }

  public Principal principal(long userId) {
    AppUser user = users.findById(userId).orElseThrow();
    return new Principal(userId, user.isAdmin());
  }

  public String token(long userId) {
    return identity.issueToken(userId);
  }

  public String bearer(long userId) {
    return "Bearer " + token(userId);
  }

  public long group(String name, long... memberIds) {
    long groupId = identity.createGroup(name);
    for (long memberId : memberIds) {
      identity.addMember(groupId, memberId);
    }
    return groupId;
  }

  public long publish(String name, StepSpec... steps) {
    long id = definitions.createDraft(name, List.of(steps));
    definitions.publish(id);
    return id;
  }

  public long draft(Principal owner, String definitionName, String title) {
    return documents.create(owner, title, "Invented body text for " + title, definitionName);
  }

  public static StepSpec step(
      int order, StepKind kind, Long assigneeId, Long groupId, int quorum, int slaMinutes) {
    return new StepSpec(order, kind, assigneeId, groupId, quorum, slaMinutes);
  }

  static String slug(String displayName) {
    return displayName.toLowerCase().replaceAll("[^a-z0-9]+", ".").replaceAll("^\\.|\\.$", "");
  }
}
