package com.papertrail.workflow.api;

import static org.assertj.core.api.Assertions.assertThat;

import com.papertrail.workflow.support.TestConfig;
import com.papertrail.workflow.support.TestData;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * Real HTTP against a started server, not MockMvc. MockMvc skips the servlet container's request
 * handling, so an ordering or path bug that only a real container shows is caught here, and every
 * kind of route should have a case in this class.
 */
@SpringBootTest(
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = {
      "workflow.admin-token=test-admin-token-0123456789",
      "workflow.scheduling-enabled=false"
    })
@Import(TestConfig.class)
class RealHttpTest {

  private static final String ADMIN = "Bearer test-admin-token-0123456789";

  @LocalServerPort private int port;
  @Autowired private JdbcTemplate jdbc;
  @Autowired private TestData data;

  private final HttpClient http = HttpClient.newHttpClient();

  @BeforeEach
  void emptySchema() {
    jdbc.execute(
        "TRUNCATE outbox_event, audit_event, document_permission, approval_task, document,"
            + " step_definition, workflow_definition, group_member, user_group, api_token,"
            + " app_user RESTART IDENTITY CASCADE");
  }

  private HttpResponse<String> send(String method, String path, String authorization, String body)
      throws Exception {
    HttpRequest.Builder request =
        HttpRequest.newBuilder(URI.create("http://localhost:" + port + path));
    if (authorization != null) {
      request.header("Authorization", authorization);
    }
    if (body != null) {
      request.header("Content-Type", "application/json");
    }
    request.method(
        method,
        body == null
            ? HttpRequest.BodyPublishers.noBody()
            : HttpRequest.BodyPublishers.ofString(body));
    return http.send(request.build(), HttpResponse.BodyHandlers.ofString());
  }

  @Test
  void aUserRouteAnswersOverRealHttp() throws Exception {
    long user = data.user("Tomas Vale");

    HttpResponse<String> response = send("GET", "/api/v1/users/me", data.bearer(user), null);

    assertThat(response.statusCode()).isEqualTo(200);
    assertThat(response.body()).contains("Tomas Vale");
  }

  @Test
  void anAdminRouteAnswersOverRealHttp() throws Exception {
    data.user("Tomas Vale");

    HttpResponse<String> response = send("GET", "/api/v1/admin/users", ADMIN, null);

    assertThat(response.statusCode()).isEqualTo(200);
    assertThat(response.body()).contains("Tomas Vale");
  }

  @Test
  void aUserRouteRefusesAMissingToken() throws Exception {
    assertThat(send("GET", "/api/v1/users/me", null, null).statusCode()).isEqualTo(401);
  }

  @Test
  void aUserTokenCannotReachTheAdminRoutes() throws Exception {
    long user = data.user("Tomas Vale");

    assertThat(send("GET", "/api/v1/admin/users", data.bearer(user), null).statusCode())
        .isEqualTo(401);
  }

  @Test
  void encodedOrParameterisedPathsAreRefusedWhoeverPresentsWhatToken() throws Exception {
    long user = data.user("Tomas Vale");
    String userBearer = data.bearer(user);

    // The admin route, reached through a percent-encoded segment or a path parameter, with no
    // token.
    HttpResponse<String> refused = send("GET", "/%61pi/v1/admin/users", null, null);
    assertThat(refused.statusCode()).isEqualTo(400);
    assertThat(refused.headers().firstValue("X-Request-Id"))
        .as("the logging filter runs before the guard, so a refusal is traced too")
        .isPresent();
    assertThat(send("GET", "/api;x=1/v1/admin/users", null, null).statusCode()).isEqualTo(400);
    assertThat(
            send(
                    "POST",
                    "/%61pi/v1/admin/users",
                    null,
                    "{\"displayName\":\"Eve\",\"email\":\"eve@example.com\",\"admin\":true}")
                .statusCode())
        .isEqualTo(400);
    // The same routes with a user's token: encoding and parameters never reach the admin check.
    assertThat(send("GET", "/api/v1/admin;x=1/users", userBearer, null).statusCode())
        .isEqualTo(400);
    assertThat(send("GET", "/api/v1/%61dmin/users", userBearer, null).statusCode()).isEqualTo(400);
    assertThat(send("GET", "/api/v1/%75sers/me", userBearer, null).statusCode()).isEqualTo(400);

    // Nothing was created by the refused requests.
    assertThat(jdbc.queryForObject("select count(*) from app_user", Long.class)).isEqualTo(1L);
  }
}
