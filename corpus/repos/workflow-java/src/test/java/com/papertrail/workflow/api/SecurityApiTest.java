package com.papertrail.workflow.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.papertrail.workflow.support.IntegrationTestBase;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;

class SecurityApiTest extends IntegrationTestBase {

  private static final String AUTH = "Authorization";

  @Test
  void aRequestWithoutATokenGetsAChallenge() throws Exception {
    mvc.perform(get("/api/v1/documents"))
        .andExpect(status().isUnauthorized())
        .andExpect(header().string("WWW-Authenticate", "Bearer"))
        .andExpect(jsonPath("$.status").value(401));
  }

  @Test
  void anUnknownTokenIsRefused() throws Exception {
    mvc.perform(get("/api/v1/documents").header(AUTH, "Bearer abcdefgh." + "x".repeat(32)))
        .andExpect(status().isUnauthorized());
  }

  @Test
  void aTokenWithTheWrongShapeIsRefused() throws Exception {
    mvc.perform(get("/api/v1/documents").header(AUTH, "Bearer notatoken"))
        .andExpect(status().isUnauthorized());
  }

  @Test
  void aRevokedTokenStopsWorking() throws Exception {
    long user = data.user("Ines Berg");
    String token = data.token(user);
    String prefix = token.substring(0, 8);
    mvc.perform(get("/api/v1/documents").header(AUTH, "Bearer " + token))
        .andExpect(status().isOk());

    mvc.perform(post("/api/v1/admin/tokens/" + prefix + "/revoke").header(AUTH, ADMIN_AUTH))
        .andExpect(status().isNoContent());

    mvc.perform(get("/api/v1/documents").header(AUTH, "Bearer " + token))
        .andExpect(status().isUnauthorized());
  }

  @Test
  void aDeactivatedUserCannotUseAValidToken() throws Exception {
    long user = data.user("Ines Berg");
    String token = data.token(user);
    jdbc.update("update app_user set active = false where id = ?", user);

    mvc.perform(get("/api/v1/documents").header(AUTH, "Bearer " + token))
        .andExpect(status().isUnauthorized());
  }

  @Test
  void theAdminTokenIsNotAUserToken() throws Exception {
    mvc.perform(get("/api/v1/documents").header(AUTH, ADMIN_AUTH))
        .andExpect(status().isUnauthorized());
  }

  @Test
  void aMalformedBodyIsRejectedAsMalformed() throws Exception {
    long user = data.user("Ines Berg");

    mvc.perform(
            post("/api/v1/documents")
                .header(AUTH, data.bearer(user))
                .contentType(MediaType.APPLICATION_JSON)
                .content("{not json"))
        .andExpect(status().isBadRequest())
        .andExpect(jsonPath("$.type").value("urn:workflow:problem:malformed-request"));
  }

  @Test
  void theTokenIsStoredOnlyAsAHash() {
    long user = data.user("Ines Berg");
    String token = data.token(user);

    String stored =
        jdbc.queryForObject(
            "select secret_hash from api_token where prefix = ?",
            String.class,
            token.substring(0, 8));

    assertThat(stored).matches("[0-9a-f]{64}").doesNotContain(token.substring(9));
  }
}
