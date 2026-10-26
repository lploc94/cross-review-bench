package com.papertrail.workflow.api;

import com.papertrail.workflow.service.IdentityService;
import com.papertrail.workflow.service.Views.TokenView;
import com.papertrail.workflow.service.Views.UserView;
import java.util.List;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * The caller's own profile and tokens. A token shows only its prefix and dates, never its secret.
 */
@RestController
@RequestMapping("/api/v1/users/me")
public class UserController {

  private final IdentityService identity;
  private final CurrentPrincipal current;

  public UserController(IdentityService identity, CurrentPrincipal current) {
    this.identity = identity;
    this.current = current;
  }

  @GetMapping
  public UserView me() {
    return identity.view(current.require().userId());
  }

  @GetMapping("/tokens")
  public List<TokenView> tokens() {
    return identity.tokensOf(current.require().userId());
  }

  /** Signs the caller out everywhere: every live token of the caller is revoked. */
  @PostMapping("/tokens/revoke")
  public ResponseEntity<Void> revokeTokens() {
    identity.revokeAllTokens(current.require().userId());
    return ResponseEntity.noContent().build();
  }
}
