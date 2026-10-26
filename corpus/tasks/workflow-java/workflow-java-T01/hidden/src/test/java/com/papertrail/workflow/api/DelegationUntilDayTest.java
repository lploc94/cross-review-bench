package com.papertrail.workflow.api;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.papertrail.workflow.domain.StepKind;
import com.papertrail.workflow.service.DocumentService;
import com.papertrail.workflow.support.IntegrationTestBase;
import com.papertrail.workflow.support.TestData;
import java.time.Instant;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.ResultActions;

/** A delegation from Monday until Wednesday is in force all of Wednesday and over on Thursday. */
class DelegationUntilDayTest extends IntegrationTestBase {

  @Autowired private DocumentService documents;

  private long delegate;

  @Test
  void theUntilDayIsIncludedAndTheDayAfterIsNot() throws Exception {
    long owner = data.user("Ines Berg");
    long approver = data.user("Tomas Vale");
    delegate = data.user("Lena Hart");
    data.publish("Contract", TestData.step(1, StepKind.SINGLE, approver, null, 0, 480));
    long first = data.draft(data.principal(owner), "Contract", "Supplier contract");
    long second = data.draft(data.principal(owner), "Contract", "Office lease");
    documents.submit(data.principal(owner), first);
    documents.submit(data.principal(owner), second);
    mvc.perform(
            post("/api/v1/delegations")
                .header("Authorization", data.bearer(approver))
                .contentType(MediaType.APPLICATION_JSON)
                .content(
                    "{\"delegateId\":%d,\"from\":\"2027-05-03\",\"until\":\"2027-05-05\"}"
                        .formatted(delegate)))
        .andExpect(status().isCreated());

    // Wednesday 17:30 in London
    clock.set(Instant.parse("2027-05-05T16:30:00Z"));
    decide(taskOf(first, approver)).andExpect(status().isOk());

    // Thursday 10:00 in London
    clock.set(Instant.parse("2027-05-06T09:00:00Z"));
    decide(taskOf(second, approver)).andExpect(status().isNotFound());
  }

  private ResultActions decide(long taskId) throws Exception {
    return mvc.perform(
        post("/api/v1/tasks/" + taskId + "/decision")
            .header("Authorization", data.bearer(delegate))
            .contentType(MediaType.APPLICATION_JSON)
            .content("{\"decision\":\"APPROVE\"}"));
  }
}
