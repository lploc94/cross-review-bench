package com.papertrail.workflow.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.papertrail.workflow.domain.StepKind;
import com.papertrail.workflow.service.DocumentService;
import com.papertrail.workflow.support.IntegrationTestBase;
import com.papertrail.workflow.support.TestData;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.MediaType;

/** A user who is not an admin cannot name another user as the delegator. */
class DelegationCreatorTest extends IntegrationTestBase {

  @Autowired private DocumentService documents;

  @Test
  void aUserCannotTakeOverAnotherUsersTasksByNamingThemAsDelegator() throws Exception {
    long owner = data.user("Ines Berg");
    long approver = data.user("Tomas Vale");
    long colleague = data.user("Lena Hart");
    data.publish("Contract", TestData.step(1, StepKind.SINGLE, approver, null, 0, 480));
    long document = data.draft(data.principal(owner), "Contract", "Supplier contract");
    documents.submit(data.principal(owner), document);
    String bearer = data.bearer(colleague);

    mvc.perform(
            post("/api/v1/delegations")
                .header("Authorization", bearer)
                .contentType(MediaType.APPLICATION_JSON)
                .content(
                    "{\"delegatorId\":%d,\"delegateId\":%d,\"from\":\"2027-05-03\",\"until\":\"2027-05-07\"}"
                        .formatted(approver, colleague)))
        .andExpect(status().isForbidden());

    mvc.perform(
            post("/api/v1/tasks/" + taskOf(document, approver) + "/decision")
                .header("Authorization", bearer)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"decision\":\"APPROVE\"}"))
        .andExpect(status().isNotFound());
    assertThat(jdbc.queryForObject("select count(*) from delegation", Integer.class)).isZero();
    assertThat(
            jdbc.queryForObject(
                "select status from approval_task where assignee_id = ?", String.class, approver))
        .isEqualTo("OPEN");
  }
}
