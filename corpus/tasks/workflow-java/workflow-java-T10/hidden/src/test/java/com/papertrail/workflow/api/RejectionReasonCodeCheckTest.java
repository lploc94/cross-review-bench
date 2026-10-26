package com.papertrail.workflow.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.papertrail.workflow.domain.RejectionReason;
import com.papertrail.workflow.domain.StepKind;
import com.papertrail.workflow.service.DefinitionService;
import com.papertrail.workflow.service.DocumentService;
import com.papertrail.workflow.support.IntegrationTestBase;
import com.papertrail.workflow.support.TestData;
import java.util.List;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.ResultActions;

/** A rejection whose reason is absent or not on the definition's list is a 400, not a 500. */
class RejectionReasonCodeCheckTest extends IntegrationTestBase {

  private static final String AUTH = "Authorization";

  @Autowired private DefinitionService definitions;
  @Autowired private DocumentService documents;

  private long approver;
  private long task;

  @BeforeEach
  void setUp() {
    long owner = data.user("Ines Berg");
    approver = data.user("Tomas Vale");
    long definition =
        definitions.createDraft(
            "Expenses", List.of(TestData.step(1, StepKind.SINGLE, approver, null, 0, 480)));
    definitions.replaceRejectionReasons(
        definition,
        List.of(
            new RejectionReason("MISSING_RECEIPTS", "Receipts are missing"),
            new RejectionReason("OVER_BUDGET", "Over the approved budget")));
    definitions.publish(definition);
    long id = data.draft(data.principal(owner), "Expenses", "Travel claim");
    documents.submit(data.principal(owner), id);
    task = taskOf(id, approver);
  }

  private ResultActions decide(String body) throws Exception {
    return mvc.perform(
        post("/api/v1/tasks/" + task + "/decision")
            .header(AUTH, data.bearer(approver))
            .contentType(MediaType.APPLICATION_JSON)
            .content(body));
  }

  private String taskStatus() {
    return jdbc.queryForObject("select status from approval_task where id = ?", String.class, task);
  }

  @Test
  void anUnknownCodeIsABadRequest() throws Exception {
    decide("{\"decision\":\"REJECT\",\"reason\":\"WRONG_COLOUR\"}")
        .andExpect(status().isBadRequest())
        .andExpect(jsonPath("$.type").value("urn:workflow:problem:invalid-reason"));

    assertThat(taskStatus()).isEqualTo("OPEN");
  }

  @Test
  void aMissingCodeIsABadRequest() throws Exception {
    decide("{\"decision\":\"REJECT\",\"comment\":\"Please redo\"}")
        .andExpect(status().isBadRequest())
        .andExpect(jsonPath("$.type").value("urn:workflow:problem:invalid-reason"));

    assertThat(taskStatus()).isEqualTo("OPEN");
  }

  @Test
  void aBlankCodeIsABadRequest() throws Exception {
    decide("{\"decision\":\"REJECT\",\"reason\":\"   \"}")
        .andExpect(status().isBadRequest())
        .andExpect(jsonPath("$.type").value("urn:workflow:problem:invalid-reason"));

    assertThat(taskStatus()).isEqualTo("OPEN");
  }

  @Test
  void aListedCodeStillRejects() throws Exception {
    decide("{\"decision\":\"REJECT\",\"reason\":\"MISSING_RECEIPTS\"}")
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.rejectionReason").value("MISSING_RECEIPTS"));

    assertThat(taskStatus()).isEqualTo("REJECTED");
  }
}
