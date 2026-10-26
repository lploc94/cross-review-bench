package com.papertrail.workflow.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.papertrail.workflow.domain.Principal;
import com.papertrail.workflow.domain.ValidationException;
import com.papertrail.workflow.support.IntegrationTestBase;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

class IdentityServiceTest extends IntegrationTestBase {

  @Autowired private IdentityService identity;

  @Test
  void aValidTokenAuthenticatesItsUserAndAdminFlag() {
    long admin = data.admin("Ines Berg");

    assertThat(identity.authenticate(data.token(admin))).contains(new Principal(admin, true));
  }

  @Test
  void aWrongSecretWithTheRightPrefixIsRefused() {
    long user = data.user("Tomas Vale");
    String token = data.token(user);
    String forged = token.substring(0, 9) + "z".repeat(32);

    assertThat(identity.authenticate(forged)).isEmpty();
    assertThat(identity.authenticate(null)).isEmpty();
  }

  @Test
  void aTokenCannotBeIssuedToAnInactiveUser() {
    long user = data.user("Tomas Vale");
    jdbc.update("update app_user set active = false where id = ?", user);

    assertThatThrownBy(() -> identity.issueToken(user)).isInstanceOf(ValidationException.class);
  }
}
