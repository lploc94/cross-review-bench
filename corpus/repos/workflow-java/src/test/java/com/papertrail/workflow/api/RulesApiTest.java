package com.papertrail.workflow.api;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.papertrail.workflow.domain.StepKind;
import com.papertrail.workflow.support.IntegrationTestBase;
import com.papertrail.workflow.support.TestData;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;

/** Rules the README states: what a decided list holds, and what a missing or stalled step does. */
class RulesApiTest extends IntegrationTestBase {

  private static final String AUTH = "Authorization";

  private long owner;
  private long first;
  private long second;

  @BeforeEach
  void setUp() {
    owner = data.user("Ines Berg");
    first = data.user("Tomas Vale");
    second = data.user("Lena Hart");
  }

  private long submit(String definition) throws Exception {
    long document = data.draft(data.principal(owner), definition, "Claim");
    mvc.perform(post("/api/v1/documents/" + document + "/submit").header(AUTH, data.bearer(owner)))
        .andExpect(status().isNoContent());
    return document;
  }

  @Test
  void theDecidedListHoldsOnlyTheTasksTheCallerDecided() throws Exception {
    long panel = data.group("panel", first, second);
    data.publish("Panel", TestData.step(1, StepKind.ANY_OF, null, panel, 0, 480));
    long document = submit("Panel");

    mvc.perform(
            post("/api/v1/tasks/" + taskOf(document, first) + "/decision")
                .header(AUTH, data.bearer(first))
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"decision\":\"APPROVE\"}"))
        .andExpect(status().isOk());

    mvc.perform(get("/api/v1/tasks/decided").header(AUTH, data.bearer(second)))
        .andExpect(jsonPath("$.items.length()").value(0));
    mvc.perform(get("/api/v1/tasks/decided").header(AUTH, data.bearer(first)))
        .andExpect(jsonPath("$.items.length()").value(1))
        .andExpect(jsonPath("$.items[0].status").value("APPROVED"));
  }

  @Test
  void aMissingUserHasNoTaskQueue() throws Exception {
    mvc.perform(get("/api/v1/admin/users/999999/tasks").header(AUTH, ADMIN_AUTH))
        .andExpect(status().isNotFound());
  }

  @Test
  void aStepWithNoActiveApproverRefusesTheAdvanceAndKeepsTheDecision() throws Exception {
    data.publish(
        "Two steps",
        TestData.step(1, StepKind.SINGLE, first, null, 0, 480),
        TestData.step(2, StepKind.SINGLE, second, null, 0, 480));
    long document = submit("Two steps");
    mvc.perform(
            patch("/api/v1/admin/users/" + second)
                .header(AUTH, ADMIN_AUTH)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"active\":false}"))
        .andExpect(status().isOk());

    mvc.perform(
            post("/api/v1/tasks/" + taskOf(document, first) + "/decision")
                .header(AUTH, data.bearer(first))
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"decision\":\"APPROVE\"}"))
        .andExpect(status().isBadRequest())
        .andExpect(jsonPath("$.detail").value("the approver of a SINGLE step is inactive"));

    // The approval rolled back with the failed advance: the review is still at order 1, and the
    // task is still open for the same approver.
    mvc.perform(get("/api/v1/documents/" + document).header(AUTH, data.bearer(owner)))
        .andExpect(jsonPath("$.summary.status").value("IN_REVIEW"))
        .andExpect(jsonPath("$.summary.currentOrder").value(1));
    mvc.perform(get("/api/v1/tasks/mine").header(AUTH, data.bearer(first)))
        .andExpect(jsonPath("$[0].status").value("OPEN"));
  }
}
