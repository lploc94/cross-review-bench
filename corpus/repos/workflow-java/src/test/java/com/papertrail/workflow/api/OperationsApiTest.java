package com.papertrail.workflow.api;

import static org.hamcrest.Matchers.containsString;
import static org.hamcrest.Matchers.not;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.papertrail.workflow.domain.StepKind;
import com.papertrail.workflow.support.IntegrationTestBase;
import com.papertrail.workflow.support.TestConfig;
import com.papertrail.workflow.support.TestData;
import java.time.Duration;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MvcResult;

/** The operator routes and the caller's own reads: each one filtered or gated as documented. */
class OperationsApiTest extends IntegrationTestBase {

  private static final String AUTH = "Authorization";
  private static final MediaType JSON = MediaType.APPLICATION_JSON;

  private long owner;
  private long approver;
  private long viewer;
  private long stranger;

  @BeforeEach
  void setUp() {
    owner = data.user("Ines Berg");
    approver = data.user("Tomas Vale");
    viewer = data.user("Lena Hart");
    stranger = data.user("Omar Lind");
    data.publish("Contract", TestData.step(1, StepKind.SINGLE, approver, null, 0, 480));
  }

  private long submittedDocument() throws Exception {
    long id = data.draft(data.principal(owner), "Contract", "Supplier contract");
    mvc.perform(post("/api/v1/documents/" + id + "/submit").header(AUTH, data.bearer(owner)))
        .andExpect(status().isNoContent());
    return id;
  }

  @Test
  void deactivatingAUserRevokesTheirTokensUntilTheyAreReactivated() throws Exception {
    String bearer = data.bearer(approver);
    mvc.perform(get("/api/v1/users/me").header(AUTH, bearer)).andExpect(status().isOk());

    mvc.perform(
            patch("/api/v1/admin/users/" + approver)
                .header(AUTH, ADMIN_AUTH)
                .contentType(JSON)
                .content("{\"active\":false}"))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.active").value(false));
    mvc.perform(get("/api/v1/users/me").header(AUTH, bearer)).andExpect(status().isUnauthorized());
    mvc.perform(get("/api/v1/admin/users?active=false").header(AUTH, ADMIN_AUTH))
        .andExpect(jsonPath("$.items[0].id").value(approver));

    mvc.perform(
            patch("/api/v1/admin/users/" + approver)
                .header(AUTH, ADMIN_AUTH)
                .contentType(JSON)
                .content("{\"active\":true}"))
        .andExpect(jsonPath("$.active").value(true));
    mvc.perform(get("/api/v1/users/me").header(AUTH, bearer)).andExpect(status().isUnauthorized());
  }

  @Test
  void anAdminCanRevokeAllTokensOfAUserAndTheTokenListingHidesSecrets() throws Exception {
    String token = data.token(viewer);
    mvc.perform(get("/api/v1/admin/users/" + viewer + "/tokens").header(AUTH, ADMIN_AUTH))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$[0].prefix").value(token.substring(0, 8)))
        .andExpect(content().string(not(containsString(token.substring(9)))));

    mvc.perform(post("/api/v1/admin/users/" + viewer + "/tokens/revoke").header(AUTH, ADMIN_AUTH))
        .andExpect(status().isNoContent());
    mvc.perform(get("/api/v1/users/me").header(AUTH, "Bearer " + token))
        .andExpect(status().isUnauthorized());
  }

  @Test
  void aUserCanSignOutEverywhere() throws Exception {
    String bearer = data.bearer(viewer);
    mvc.perform(post("/api/v1/users/me/tokens/revoke").header(AUTH, bearer))
        .andExpect(status().isNoContent());
    mvc.perform(get("/api/v1/users/me").header(AUTH, bearer)).andExpect(status().isUnauthorized());
  }

  @Test
  void aGroupCannotTakeAnotherNameAndAGroupInUseCannotBeDeleted() throws Exception {
    long finance = data.group("finance");
    long legal = data.group("legal");
    data.publish("Invoice", TestData.step(1, StepKind.ANY_OF, null, finance, 0, 480));

    mvc.perform(
            patch("/api/v1/admin/groups/" + legal)
                .header(AUTH, ADMIN_AUTH)
                .contentType(JSON)
                .content("{\"name\":\"finance\"}"))
        .andExpect(status().isConflict());
    mvc.perform(delete("/api/v1/admin/groups/" + finance).header(AUTH, ADMIN_AUTH))
        .andExpect(status().isConflict());
    mvc.perform(delete("/api/v1/admin/groups/" + legal).header(AUTH, ADMIN_AUTH))
        .andExpect(status().isNoContent());
    mvc.perform(get("/api/v1/admin/groups").header(AUTH, ADMIN_AUTH))
        .andExpect(jsonPath("$.length()").value(1))
        .andExpect(jsonPath("$[0].name").value("finance"));
  }

  @Test
  void aPublishedDefinitionIsRevisedIntoADraftThatCopiesItsSteps() throws Exception {
    long published =
        data.publish(
            "Expenses",
            TestData.step(1, StepKind.SINGLE, approver, null, 0, 480),
            TestData.step(2, StepKind.SINGLE, viewer, null, 0, 240));

    MvcResult revised =
        mvc.perform(
                post("/api/v1/admin/definitions/" + published + "/revise").header(AUTH, ADMIN_AUTH))
            .andExpect(status().isCreated())
            .andReturn();
    long draft = idFrom(revised);
    mvc.perform(get("/api/v1/admin/definitions/" + draft).header(AUTH, ADMIN_AUTH))
        .andExpect(jsonPath("$.version").value(2))
        .andExpect(jsonPath("$.published").value(false))
        .andExpect(jsonPath("$.steps.length()").value(2))
        .andExpect(jsonPath("$.steps[1].slaMinutes").value(240));
    mvc.perform(post("/api/v1/admin/definitions/" + draft + "/revise").header(AUTH, ADMIN_AUTH))
        .andExpect(status().isConflict());
    mvc.perform(get("/api/v1/definitions?name=Expenses").header(AUTH, data.bearer(approver)))
        .andExpect(jsonPath("$.length()").value(1));
  }

  @Test
  void aDraftStepCanBeReplacedAndADraftDiscardedButAPublishedDefinitionCannot() throws Exception {
    MvcResult created =
        mvc.perform(
                post("/api/v1/admin/definitions")
                    .header(AUTH, ADMIN_AUTH)
                    .contentType(JSON)
                    .content(
                        "{\"name\":\"Travel\",\"steps\":[{\"order\":1,\"kind\":\"SINGLE\","
                            + "\"assigneeId\":"
                            + approver
                            + ",\"slaMinutes\":480}]}"))
            .andExpect(status().isCreated())
            .andReturn();
    long draft = idFrom(created);
    long stepId =
        jdbc.queryForObject(
            "select id from step_definition where definition_id = ?", Long.class, draft);

    mvc.perform(
            put("/api/v1/admin/definitions/" + draft + "/steps/" + stepId)
                .header(AUTH, ADMIN_AUTH)
                .contentType(JSON)
                .content(
                    "{\"order\":1,\"kind\":\"SINGLE\",\"assigneeId\":"
                        + viewer
                        + ",\"slaMinutes\":120}"))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.steps.length()").value(1))
        .andExpect(jsonPath("$.steps[0].assigneeName").value("Lena Hart"));
    mvc.perform(delete("/api/v1/admin/definitions/" + draft).header(AUTH, ADMIN_AUTH))
        .andExpect(status().isNoContent());

    long published =
        data.publish("Leave", TestData.step(1, StepKind.SINGLE, approver, null, 0, 60));
    mvc.perform(delete("/api/v1/admin/definitions/" + published).header(AUTH, ADMIN_AUTH))
        .andExpect(status().isConflict());
  }

  @Test
  void aGivenUpOutboxEventIsRequeuedOnceAndOnlyFailedEventsAreDiscarded() throws Exception {
    String approverEmail =
        jdbc.queryForObject("select email from app_user where id = ?", String.class, approver);
    jdbc.update(
        "insert into outbox_event (idempotency_key, event_type, recipient_user_id,"
            + " recipient_email, payload, status, attempts, next_attempt_at, last_error,"
            + " created_at) values ('failed:1', 'TASK_ASSIGNED', ?, ?, '{}', 'FAILED', 5, now(),"
            + " 'connection refused', now())",
        approver,
        approverEmail);
    long event =
        jdbc.queryForObject(
            "select id from outbox_event where idempotency_key = 'failed:1'", Long.class);

    mvc.perform(get("/api/v1/admin/outbox?status=FAILED").header(AUTH, ADMIN_AUTH))
        .andExpect(jsonPath("$.items[0].id").value(event))
        .andExpect(jsonPath("$.items[0].recipientEmail").doesNotExist());
    mvc.perform(post("/api/v1/admin/outbox/" + event + "/requeue").header(AUTH, ADMIN_AUTH))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.status").value("PENDING"))
        .andExpect(jsonPath("$.attempts").value(0));
    mvc.perform(post("/api/v1/admin/outbox/" + event + "/requeue").header(AUTH, ADMIN_AUTH))
        .andExpect(status().isConflict());
    mvc.perform(delete("/api/v1/admin/outbox/" + event).header(AUTH, ADMIN_AUTH))
        .andExpect(status().isConflict());
    mvc.perform(post("/api/v1/admin/outbox/requeue-failed").header(AUTH, ADMIN_AUTH))
        .andExpect(jsonPath("$.count").value(0));
  }

  @Test
  void theAuditTrailAndTheSummaryAreForOperators() throws Exception {
    long id = submittedDocument();

    mvc.perform(get("/api/v1/admin/audit").header(AUTH, ADMIN_AUTH))
        .andExpect(jsonPath("$.items[0].documentId").value(id))
        .andExpect(jsonPath("$.items[0].action").value("CREATED"));
    mvc.perform(get("/api/v1/admin/summary").header(AUTH, ADMIN_AUTH))
        .andExpect(jsonPath("$.activeUsers").value(4))
        .andExpect(jsonPath("$.documents.IN_REVIEW").value(1))
        .andExpect(jsonPath("$.openTasks").value(1));
  }

  @Test
  void sharedAndOwnedFiltersNarrowTheListsAndAccessShowsWhoCanSee() throws Exception {
    long id = data.draft(data.principal(owner), "Contract", "Shared contract");
    mvc.perform(
            put("/api/v1/documents/" + id + "/permissions/" + viewer)
                .header(AUTH, data.bearer(owner))
                .contentType(JSON)
                .content("{\"level\":\"VIEW\"}"))
        .andExpect(status().isNoContent());

    mvc.perform(get("/api/v1/documents?shared=true").header(AUTH, data.bearer(viewer)))
        .andExpect(jsonPath("$.items.length()").value(1))
        .andExpect(jsonPath("$.items[0].id").value(id));
    mvc.perform(get("/api/v1/documents?shared=true").header(AUTH, data.bearer(owner)))
        .andExpect(jsonPath("$.items.length()").value(0));
    mvc.perform(get("/api/v1/documents/count?owner=" + stranger).header(AUTH, data.bearer(owner)))
        .andExpect(jsonPath("$.count").value(0));
    mvc.perform(get("/api/v1/documents?definition=Contract").header(AUTH, data.bearer(owner)))
        .andExpect(jsonPath("$.items.length()").value(1));
    mvc.perform(get("/api/v1/documents/" + id + "/access").header(AUTH, data.bearer(owner)))
        .andExpect(jsonPath("$.ownerId").value(owner))
        .andExpect(jsonPath("$.grants[0].userId").value(viewer));
  }

  @Test
  void approversReadTheirTasksAndOperatorsSeeOverdueWork() throws Exception {
    long id = submittedDocument();
    long task = taskOf(id, approver);

    mvc.perform(get("/api/v1/tasks/" + task).header(AUTH, data.bearer(approver)))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.documentId").value(id));
    mvc.perform(get("/api/v1/tasks/" + task).header(AUTH, data.bearer(stranger)))
        .andExpect(status().isNotFound());
    mvc.perform(get("/api/v1/tasks/mine/count").header(AUTH, data.bearer(approver)))
        .andExpect(jsonPath("$.count").value(1));

    clock.set(TestConfig.START.plus(Duration.ofDays(2)));
    mvc.perform(get("/api/v1/admin/tasks/overdue").header(AUTH, ADMIN_AUTH))
        .andExpect(jsonPath("$.items[0].id").value(task));

    mvc.perform(
            post("/api/v1/tasks/" + task + "/decision")
                .header(AUTH, data.bearer(approver))
                .contentType(JSON)
                .content("{\"decision\":\"APPROVE\",\"comment\":\"Checked\"}"))
        .andExpect(status().isOk());
    mvc.perform(get("/api/v1/tasks/decided").header(AUTH, data.bearer(approver)))
        .andExpect(jsonPath("$.items[0].id").value(task))
        .andExpect(jsonPath("$.items[0].status").value("APPROVED"));
    mvc.perform(get("/api/v1/documents/" + id + "/rounds").header(AUTH, data.bearer(owner)))
        .andExpect(jsonPath("$[0].round").value(1))
        .andExpect(jsonPath("$[0].tasks[0].status").value("APPROVED"));
  }

  @Test
  void theDueTimeOfAnSlaIsWorkedOutInTheBusinessCalendar() throws Exception {
    mvc.perform(
            get("/api/v1/calendar/due?from=2027-05-03T10:00:00Z&minutes=60")
                .header(AUTH, data.bearer(approver)))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.dueAt").value("2027-05-03T11:00:00Z"));
    mvc.perform(
            get("/api/v1/calendar/due?from=2027-05-03T10:00:00Z&minutes=0")
                .header(AUTH, data.bearer(approver)))
        .andExpect(status().isBadRequest());
    mvc.perform(
            get("/api/v1/calendar/due")
                .param("from", "+1000000000-12-31T23:59:59Z")
                .param("minutes", "30")
                .header(AUTH, data.bearer(approver)))
        .andExpect(status().isBadRequest());
    mvc.perform(get("/api/v1/calendar/working-hours").header(AUTH, data.bearer(approver)))
        .andExpect(jsonPath("$.zone").value("Europe/London"));
  }

  @Test
  void aCallerSeesOnlyTheirOwnNotifications() throws Exception {
    submittedDocument();

    mvc.perform(get("/api/v1/notifications/mine").header(AUTH, data.bearer(approver)))
        .andExpect(jsonPath("$.items[0].eventType").exists());
    mvc.perform(get("/api/v1/notifications/mine").header(AUTH, data.bearer(stranger)))
        .andExpect(jsonPath("$.items").isEmpty());
    mvc.perform(get("/api/v1/users/me").header(AUTH, data.bearer(approver)))
        .andExpect(jsonPath("$.displayName").value("Tomas Vale"));
  }
}
