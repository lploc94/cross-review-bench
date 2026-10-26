package com.papertrail.workflow.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.papertrail.workflow.domain.Decision;
import com.papertrail.workflow.domain.StepKind;
import com.papertrail.workflow.service.ApprovalService;
import com.papertrail.workflow.service.DocumentService;
import com.papertrail.workflow.support.IntegrationTestBase;
import com.papertrail.workflow.support.TestData;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.MediaType;

class ReassignWithinStepTest extends IntegrationTestBase {

  @Autowired private DocumentService documents;
  @Autowired private ApprovalService approvals;

  @Test
  void aMemberWhoAlreadyApprovedCannotTakeAnotherMembersTask() throws Exception {
    long owner = data.user("Ines Berg");
    long a = data.user("Tomas Vale");
    long b = data.user("Lena Hart");
    long c = data.user("Omar Lind");
    long board = data.group("board", a, b, c);
    data.publish("Contract", TestData.step(1, StepKind.ALL_OF, null, board, 0, 480));
    long document = data.draft(data.principal(owner), "Contract", "Supplier contract");
    documents.submit(data.principal(owner), document);
    long taskOfC = taskOf(document, c);

    approvals.decide(data.principal(a), taskOf(document, a), Decision.APPROVE, null);

    mvc.perform(
            post("/api/v1/admin/tasks/" + taskOfC + "/reassign")
                .header("Authorization", ADMIN_AUTH)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"userId\":" + a + ",\"reason\":\"Approver on leave\"}"))
        .andExpect(status().isConflict());

    assertThat(
            jdbc.queryForObject(
                "select count(*) from approval_task where document_id = ? and assignee_id = ?",
                Integer.class,
                document,
                a))
        .isEqualTo(1);
    assertThat(
            jdbc.queryForObject(
                "select status from approval_task where id = ?", String.class, taskOfC))
        .isEqualTo("OPEN");
    assertThat(
            jdbc.queryForObject("select status from document where id = ?", String.class, document))
        .isEqualTo("IN_REVIEW");
  }
}
