package com.papertrail.workflow.service;

import com.papertrail.workflow.domain.ApiToken;
import com.papertrail.workflow.domain.AppUser;
import com.papertrail.workflow.domain.ConflictException;
import com.papertrail.workflow.domain.NotFoundException;
import com.papertrail.workflow.domain.Principal;
import com.papertrail.workflow.domain.UserGroup;
import com.papertrail.workflow.domain.ValidationException;
import com.papertrail.workflow.persistence.ApiTokenRepository;
import com.papertrail.workflow.persistence.AppUserRepository;
import com.papertrail.workflow.persistence.StepDefinitionRepository;
import com.papertrail.workflow.persistence.UserGroupRepository;
import com.papertrail.workflow.service.Views.GroupView;
import com.papertrail.workflow.service.Views.PageView;
import com.papertrail.workflow.service.Views.TokenView;
import com.papertrail.workflow.service.Views.UserView;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.time.Clock;
import java.time.Instant;
import java.util.HexFormat;
import java.util.List;
import java.util.Optional;
import org.springframework.data.domain.PageRequest;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Users, groups and API tokens. A token is {@code <prefix>.<secret>}: the prefix finds the row, and
 * only the SHA-256 of the secret is stored, compared in constant time.
 */
@Service
public class IdentityService {

  static final int PREFIX_LENGTH = 8;
  static final int SECRET_LENGTH = 32;

  private static final String ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
  private static final String NO_TOKEN_HASH = "0".repeat(64);

  private final SecureRandom random = new SecureRandom();
  private final AppUserRepository users;
  private final UserGroupRepository groups;
  private final ApiTokenRepository tokens;
  private final StepDefinitionRepository steps;
  private final Clock clock;

  public IdentityService(
      AppUserRepository users,
      UserGroupRepository groups,
      ApiTokenRepository tokens,
      StepDefinitionRepository steps,
      Clock clock) {
    this.users = users;
    this.groups = groups;
    this.tokens = tokens;
    this.steps = steps;
    this.clock = clock;
  }

  @Transactional
  public long createUser(String displayName, String email, boolean admin) {
    String address = AppUser.normaliseEmail(email);
    if (users.findByEmail(address).isPresent()) {
      throw new ConflictException("an account with this email already exists");
    }
    return users.save(new AppUser(displayName, email, admin)).getId();
  }

  @Transactional
  public long createGroup(String name) {
    if (groups.findByName(name.trim()).isPresent()) {
      throw new ConflictException("group " + name.trim() + " already exists");
    }
    return groups.save(new UserGroup(name)).getId();
  }

  @Transactional(readOnly = true)
  public UserView view(long userId) {
    return UserView.of(requireUser(userId));
  }

  /** Users by id, optionally only the active or only the inactive ones. */
  @Transactional(readOnly = true)
  public PageView<UserView> users(Boolean active, Long cursor, Integer size) {
    int limit = Pages.limit(size);
    PageRequest first = Pages.first(limit);
    long after = Pages.after(cursor);
    List<AppUser> rows =
        active == null
            ? users.findByIdGreaterThanOrderByIdAsc(after, first)
            : users.findByActiveAndIdGreaterThanOrderByIdAsc(active, after, first);
    return Pages.of(rows, limit, AppUser::getId, UserView::of);
  }

  /**
   * Changes a user's name, email or activation; a null field keeps its value. Deactivating also
   * revokes every live token, so nothing the user holds still signs in. Reactivating does not
   * restore them: the user is issued a new token.
   */
  @Transactional
  public UserView updateUser(long userId, String displayName, String email, Boolean active) {
    AppUser user = requireUser(userId);
    if (email != null) {
      String address = AppUser.normaliseEmail(email);
      if (users.findByEmail(address).filter(other -> !other.getId().equals(userId)).isPresent()) {
        throw new ConflictException("an account with this email already exists");
      }
    }
    user.changeProfile(displayName, email);
    if (active != null) {
      if (active) {
        user.activate();
      } else {
        user.deactivate();
        Instant now = clock.instant();
        tokens.findByUserIdAndRevokedAtIsNull(userId).forEach(token -> token.revoke(now));
      }
    }
    return UserView.of(user);
  }

  /** Revokes every live token of a user, for a lost device or a suspected leak. */
  @Transactional
  public void revokeAllTokens(long userId) {
    requireUser(userId);
    Instant now = clock.instant();
    tokens.findByUserIdAndRevokedAtIsNull(userId).forEach(token -> token.revoke(now));
  }

  @Transactional(readOnly = true)
  public List<TokenView> tokensOf(long userId) {
    requireUser(userId);
    return tokens.findByUserIdOrderByIdAsc(userId).stream().map(TokenView::of).toList();
  }

  @Transactional(readOnly = true)
  public List<GroupView> groups() {
    return groups.findAllByOrderByNameAsc().stream().map(GroupView::of).toList();
  }

  /** Deletes a group, unless a workflow step still assigns to it. */
  @Transactional
  public void deleteGroup(long groupId) {
    UserGroup group = requireGroup(groupId);
    if (steps.countByGroupId(groupId) > 0) {
      throw new ConflictException("group " + group.getName() + " is used by a workflow step");
    }
    groups.delete(group);
  }

  @Transactional(readOnly = true)
  public GroupView group(long groupId) {
    return GroupView.of(requireGroup(groupId));
  }

  @Transactional
  public GroupView renameGroup(long groupId, String name) {
    UserGroup group = requireGroup(groupId);
    String wanted = name.trim();
    if (groups.findByName(wanted).filter(other -> !other.getId().equals(groupId)).isPresent()) {
      throw new ConflictException("group " + wanted + " already exists");
    }
    group.rename(wanted);
    return GroupView.of(group);
  }

  @Transactional
  public void addMember(long groupId, long userId) {
    UserGroup group = requireGroup(groupId);
    group.addMember(requireUser(userId));
  }

  @Transactional
  public void removeMember(long groupId, long userId) {
    requireGroup(groupId).removeMember(requireUser(userId));
  }

  /** Issues a token. The returned plaintext is the only copy; it is never stored. */
  @Transactional
  public String issueToken(long userId) {
    AppUser user = requireUser(userId);
    if (!user.isActive()) {
      throw new ValidationException("an inactive user cannot receive a token");
    }
    String prefix = randomText(PREFIX_LENGTH);
    String secret = randomText(SECRET_LENGTH);
    tokens.save(new ApiToken(user, prefix, sha256(secret), clock.instant()));
    return prefix + "." + secret;
  }

  @Transactional
  public void revokeToken(String prefix) {
    ApiToken token =
        tokens
            .findWithUserByPrefix(prefix)
            .orElseThrow(() -> new NotFoundException("token not found"));
    token.revoke(clock.instant());
  }

  /** Resolves a presented token to its principal, or empty when it is unknown, revoked or stale. */
  @Transactional(readOnly = true)
  public Optional<Principal> authenticate(String presented) {
    if (presented == null || presented.length() != PREFIX_LENGTH + 1 + SECRET_LENGTH) {
      return Optional.empty();
    }
    if (presented.charAt(PREFIX_LENGTH) != '.') {
      return Optional.empty();
    }
    String prefix = presented.substring(0, PREFIX_LENGTH);
    String presentedHash = sha256(presented.substring(PREFIX_LENGTH + 1));
    Optional<ApiToken> token = tokens.findWithUserByPrefix(prefix);
    String storedHash = token.map(ApiToken::getSecretHash).orElse(NO_TOKEN_HASH);
    boolean matches =
        MessageDigest.isEqual(
            storedHash.getBytes(StandardCharsets.US_ASCII),
            presentedHash.getBytes(StandardCharsets.US_ASCII));
    if (token.isEmpty() || !matches || token.get().isRevoked()) {
      return Optional.empty();
    }
    AppUser user = token.get().getUser();
    if (!user.isActive()) {
      return Optional.empty();
    }
    return Optional.of(new Principal(user.getId(), user.isAdmin()));
  }

  static String sha256(String value) {
    try {
      byte[] digest =
          MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
      return HexFormat.of().formatHex(digest);
    } catch (NoSuchAlgorithmException e) {
      throw new IllegalStateException("SHA-256 is not available", e);
    }
  }

  private String randomText(int length) {
    StringBuilder text = new StringBuilder(length);
    for (int i = 0; i < length; i++) {
      text.append(ALPHABET.charAt(random.nextInt(ALPHABET.length())));
    }
    return text.toString();
  }

  private AppUser requireUser(long userId) {
    return users.findById(userId).orElseThrow(() -> new NotFoundException("user not found"));
  }

  private UserGroup requireGroup(long groupId) {
    return groups.findById(groupId).orElseThrow(() -> new NotFoundException("group not found"));
  }
}
