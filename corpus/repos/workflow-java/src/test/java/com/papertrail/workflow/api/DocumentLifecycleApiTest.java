package com.papertrail.workflow.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.papertrail.workflow.domain.StepKind;
import com.papertrail.workflow.support.IntegrationTestBase;
import com.papertrail.workflow.support.TestData;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MvcResult;

class DocumentLifecycleApiTest extends IntegrationTestBase {

  private static final String AUTH = "Authorization";

  private long owner;
  private long approver;
  private long viewer;
  private long stranger;

  @BeforeEach
  void people() {
    owner = data.user("Ines Berg");
    approver = data.user("Tomas Vale");
    viewer = data.user("Nadia Roy");
    stranger = data.user("Omar Lind");
    data.publish("Expenses", TestData.step(1, StepKind.SINGLE, approver, null, 0, 480));
  }

  private long createDocument(String title) throws Exception {
    MvcResult result =
        mvc.perform(
                post("/api/v1/documents")
                    .header(AUTH, data.bearer(owner))
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(
                        """
                        {"title":"%s","body":"Invented claim text","definitionName":"Expenses"}"""
                            .formatted(title)))
            .andReturn();
    assertThat(result.getResponse().getStatus()).isEqualTo(201);
    return idFrom(result);
  }

  private void submit(long documentId) throws Exception {
    mvc.perform(
            post("/api/v1/documents/" + documentId + "/submit").header(AUTH, data.bearer(owner)))
        .andExpect(status().isNoContent());
  }

  @Test
  void createReturnsLocationAndTheDraft() throws Exception {
    long id = createDocument("Travel claim");

    mvc.perform(get("/api/v1/documents/" + id).header(AUTH, data.bearer(owner)))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.summary.status").value("DRAFT"))
        .andExpect(jsonPath("$.summary.round").value(0))
        .andExpect(jsonPath("$.summary.definitionVersion").value(1))
        .andExpect(jsonPath("$.body").value("Invented claim text"));
  }

  @Test
  void submitOpensTheFirstStepForItsApprover() throws Exception {
    long id = createDocument("Travel claim");

    submit(id);

    mvc.perform(get("/api/v1/documents/" + id).header(AUTH, data.bearer(owner)))
        .andExpect(jsonPath("$.summary.status").value("IN_REVIEW"))
        .andExpect(jsonPath("$.summary.currentOrder").value(1))
        .andExpect(jsonPath("$.tasks.length()").value(1))
        .andExpect(jsonPath("$.tasks[0].status").value("OPEN"))
        .andExpect(jsonPath("$.tasks[0].assigneeId").value(approver));
    assertThat(
            jdbc.queryForObject(
                "select count(*) from outbox_event where event_type = 'TASK_ASSIGNED'",
                Integer.class))
        .isEqualTo(1);
  }

  @Test
  void aStrangerSeesNotFoundAndAViewerIsForbiddenToSubmit() throws Exception {
    long id = createDocument("Travel claim");
    mvc.perform(
            put("/api/v1/documents/" + id + "/permissions/" + viewer)
                .header(AUTH, data.bearer(owner))
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"level\":\"VIEW\"}"))
        .andExpect(status().isNoContent());

    mvc.perform(get("/api/v1/documents/" + id).header(AUTH, data.bearer(stranger)))
        .andExpect(status().isNotFound());
    mvc.perform(post("/api/v1/documents/" + id + "/submit").header(AUTH, data.bearer(stranger)))
        .andExpect(status().isNotFound());
    mvc.perform(get("/api/v1/documents/" + id).header(AUTH, data.bearer(viewer)))
        .andExpect(status().isOk());
    mvc.perform(post("/api/v1/documents/" + id + "/submit").header(AUTH, data.bearer(viewer)))
        .andExpect(status().isForbidden())
        .andExpect(jsonPath("$.type").value("urn:workflow:problem:forbidden"));
  }

  @Test
  void withdrawingCancelsTheOpenTasks() throws Exception {
    long id = createDocument("Travel claim");
    submit(id);

    mvc.perform(post("/api/v1/documents/" + id + "/withdraw").header(AUTH, data.bearer(owner)))
        .andExpect(status().isNoContent());

    mvc.perform(get("/api/v1/documents/" + id).header(AUTH, data.bearer(owner)))
        .andExpect(jsonPath("$.summary.status").value("WITHDRAWN"))
        .andExpect(jsonPath("$.tasks[0].status").value("CANCELLED"));
  }

  @Test
  void aRejectionThenAResubmissionStartsRoundTwoAndKeepsTheHistory() throws Exception {
    long id = createDocument("Travel claim");
    submit(id);
    long task = taskOf(id, approver);
    mvc.perform(
            post("/api/v1/tasks/" + task + "/decision")
                .header(AUTH, data.bearer(approver))
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"decision\":\"REJECT\",\"comment\":\"Missing receipts\"}"))
        .andExpect(status().isOk());

    mvc.perform(get("/api/v1/documents/" + id).header(AUTH, data.bearer(owner)))
        .andExpect(jsonPath("$.summary.status").value("REJECTED"));
    mvc.perform(post("/api/v1/documents/" + id + "/resubmit").header(AUTH, data.bearer(owner)))
        .andExpect(status().isNoContent());

    mvc.perform(get("/api/v1/documents/" + id).header(AUTH, data.bearer(owner)))
        .andExpect(jsonPath("$.summary.status").value("IN_REVIEW"))
        .andExpect(jsonPath("$.summary.round").value(2))
        .andExpect(jsonPath("$.tasks.length()").value(2))
        .andExpect(jsonPath("$.tasks[0].round").value(1))
        .andExpect(jsonPath("$.tasks[0].status").value("REJECTED"))
        .andExpect(jsonPath("$.tasks[1].round").value(2))
        .andExpect(jsonPath("$.tasks[1].status").value("OPEN"));
  }

  @Test
  void theDraftCannotBeEditedOnceItIsInReview() throws Exception {
    long id = createDocument("Travel claim");
    submit(id);

    mvc.perform(
            put("/api/v1/documents/" + id)
                .header(AUTH, data.bearer(owner))
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"title\":\"Travel claim\",\"body\":\"Changed text\"}"))
        .andExpect(status().isConflict())
        .andExpect(jsonPath("$.type").value("urn:workflow:problem:invalid-transition"));
  }

  @Test
  void aBlankTitleIsAValidationFailure() throws Exception {
    mvc.perform(
            post("/api/v1/documents")
                .header(AUTH, data.bearer(owner))
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"title\":\" \",\"body\":\"Text\",\"definitionName\":\"Expenses\"}"))
        .andExpect(status().isBadRequest())
        .andExpect(jsonPath("$.type").value("urn:workflow:problem:validation-failed"))
        .andExpect(jsonPath("$.errors[0].field").value("title"));
  }

  @Test
  void theAuditTrailListsCreationAndSubmission() throws Exception {
    long id = createDocument("Travel claim");
    submit(id);

    mvc.perform(get("/api/v1/documents/" + id + "/audit").header(AUTH, data.bearer(owner)))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.items[0].action").value("CREATED"))
        .andExpect(jsonPath("$.items[1].action").value("SUBMITTED"))
        .andExpect(jsonPath("$.items[1].actorId").value(owner));
  }
}
