package com.papertrail.workflow.support;

import org.junit.jupiter.api.BeforeEach;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

/**
 * Base for tests against the real Postgres the harness leases. All subclasses share one Spring
 * context, so Flyway runs once. Each test starts from an empty schema and the clock at {@link
 * TestConfig#START}.
 */
@SpringBootTest(
    properties = {
      "workflow.admin-token=test-admin-token-0123456789",
      "workflow.scheduling-enabled=false",
      "spring.jpa.properties.hibernate.generate_statistics=true"
    })
@AutoConfigureMockMvc
@Import(TestConfig.class)
public abstract class IntegrationTestBase {

  protected static final String ADMIN_AUTH = "Bearer test-admin-token-0123456789";

  @Autowired protected MockMvc mvc;
  @Autowired protected JdbcTemplate jdbc;
  @Autowired protected MutableClock clock;
  @Autowired protected RecordingNotifier notifier;
  @Autowired protected TestData data;

  /** The id at the end of a create response's {@code Location} header. */
  protected static long idFrom(MvcResult result) {
    String location = result.getResponse().getHeader("Location");
    return Long.parseLong(location.substring(location.lastIndexOf('/') + 1));
  }

  /**
   * The id of the single approval task a test expects on a document, read straight from the table.
   */
  protected long taskOf(long documentId, long assigneeId) {
    return jdbc.queryForObject(
        "select id from approval_task where document_id = ? and assignee_id = ?"
            + " order by id desc limit 1",
        Long.class,
        documentId,
        assigneeId);
  }

  @BeforeEach
  void resetState() {
    jdbc.execute(
        "TRUNCATE outbox_event, audit_event, document_permission, approval_task, document,"
            + " step_definition, workflow_definition, group_member, user_group, api_token,"
            + " app_user RESTART IDENTITY CASCADE");
    clock.set(TestConfig.START);
    notifier.reset();
  }
}
