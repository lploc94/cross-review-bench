package com.papertrail.workflow.api;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.papertrail.workflow.domain.StepKind;
import com.papertrail.workflow.support.IntegrationTestBase;
import com.papertrail.workflow.support.TestData;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.ResultActions;

class ApprovalApiTest extends IntegrationTestBase {

  private static final String AUTH = "Authorization";

  private long owner;
  private long first;
  private long second;
  private long outsider;

  @BeforeEach
  void setUp() {
    owner = data.user("Ines Berg");
    first = data.user("Tomas Vale");
    second = data.user("Lena Hart");
    outsider = data.user("Omar Lind");
    data.publish(
        "Contract",
        TestData.step(1, StepKind.SINGLE, first, null, 0, 480),
        TestData.step(2, StepKind.SINGLE, second, null, 0, 480));
  }

  private long submittedDocument() throws Exception {
    MvcResult created =
        mvc.perform(
                post("/api/v1/documents")
                    .header(AUTH, data.bearer(owner))
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(
                        "{\"title\":\"Supplier contract\",\"body\":\"Invented terms\","
                            + "\"definitionName\":\"Contract\"}"))
            .andReturn();
    long id = idFrom(created);
    mvc.perform(post("/api/v1/documents/" + id + "/submit").header(AUTH, data.bearer(owner)))
        .andExpect(status().isNoContent());
    return id;
  }

  private ResultActions decide(long taskId, long actor, String decision, String comment)
      throws Exception {
    String body =
        comment == null
            ? "{\"decision\":\"" + decision + "\"}"
            : "{\"decision\":\"" + decision + "\",\"comment\":\"" + comment + "\"}";
    return mvc.perform(
        post("/api/v1/tasks/" + taskId + "/decision")
            .header(AUTH, data.bearer(actor))
            .contentType(MediaType.APPLICATION_JSON)
            .content(body));
  }

  @Test
  void theSerialStepsApproveTheDocumentInOrder() throws Exception {
    long id = submittedDocument();

    decide(taskOf(id, first), first, "APPROVE", null).andExpect(status().isOk());

    mvc.perform(get("/api/v1/documents/" + id).header(AUTH, data.bearer(owner)))
        .andExpect(jsonPath("$.summary.status").value("IN_REVIEW"))
        .andExpect(jsonPath("$.summary.currentOrder").value(2));

    decide(taskOf(id, second), second, "APPROVE", null).andExpect(status().isOk());

    mvc.perform(get("/api/v1/documents/" + id).header(AUTH, data.bearer(owner)))
        .andExpect(jsonPath("$.summary.status").value("APPROVED"));
  }

  @Test
  void aDecisionOnAnotherUsersTaskIsForbiddenOnlyWhenTheDocumentIsVisible() throws Exception {
    long id = submittedDocument();

    // An outsider cannot see the document, so the task does not exist for them.
    decide(taskOf(id, first), outsider, "APPROVE", null).andExpect(status().isNotFound());
    // The owner can see the document, but the task is someone else's.
    decide(taskOf(id, first), owner, "APPROVE", null).andExpect(status().isForbidden());
  }

  @Test
  void decidingAnAlreadyDecidedTaskIsAConflict() throws Exception {
    long id = submittedDocument();
    long task = taskOf(id, first);
    decide(task, first, "APPROVE", null).andExpect(status().isOk());

    decide(task, first, "REJECT", null)
        .andExpect(status().isConflict())
        .andExpect(jsonPath("$.type").value("urn:workflow:problem:conflict"));
  }

  @Test
  void myTasksListsOnlyMyOpenTasks() throws Exception {
    long id = submittedDocument();

    mvc.perform(get("/api/v1/tasks/mine").header(AUTH, data.bearer(first)))
        .andExpect(jsonPath("$.length()").value(1))
        .andExpect(jsonPath("$[0].documentTitle").value("Supplier contract"))
        .andExpect(jsonPath("$[0].kind").value("SINGLE"));

    decide(taskOf(id, first), first, "APPROVE", null).andExpect(status().isOk());

    mvc.perform(get("/api/v1/tasks/mine").header(AUTH, data.bearer(first)))
        .andExpect(jsonPath("$.length()").value(0));
  }

  @Test
  void theCommentIsRecordedOnTheTask() throws Exception {
    long id = submittedDocument();
    decide(taskOf(id, first), first, "APPROVE", "Looks right").andExpect(status().isOk());

    mvc.perform(get("/api/v1/documents/" + id).header(AUTH, data.bearer(owner)))
        .andExpect(jsonPath("$.tasks[0].status").value("APPROVED"))
        .andExpect(jsonPath("$.tasks[0].decisionComment").value("Looks right"));
  }
}
