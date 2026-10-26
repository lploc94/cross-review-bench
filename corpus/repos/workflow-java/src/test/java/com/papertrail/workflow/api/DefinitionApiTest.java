package com.papertrail.workflow.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.papertrail.workflow.domain.StepKind;
import com.papertrail.workflow.support.IntegrationTestBase;
import com.papertrail.workflow.support.TestData;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MvcResult;

class DefinitionApiTest extends IntegrationTestBase {

  private String stepJson(long approverId) {
    return """
        {"order":1,"kind":"SINGLE","assigneeId":%d,"slaMinutes":480}"""
        .formatted(approverId);
  }

  private MvcResult createDraft(String name, String steps) throws Exception {
    return mvc.perform(
            post("/api/v1/admin/definitions")
                .header("Authorization", ADMIN_AUTH)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"name\":\"" + name + "\",\"steps\":[" + steps + "]}"))
        .andReturn();
  }

  @Test
  void adminCreatesAndPublishesADefinition() throws Exception {
    long approver = data.user("Tomas Vale");

    MvcResult created = createDraft("Expenses", stepJson(approver));
    assertThat(created.getResponse().getStatus()).isEqualTo(201);
    long id = idFrom(created);

    mvc.perform(
            post("/api/v1/admin/definitions/" + id + "/publish")
                .header("Authorization", ADMIN_AUTH))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.published").value(true))
        .andExpect(jsonPath("$.steps[0].assigneeName").value("Tomas Vale"))
        .andExpect(jsonPath("$.steps[0].slaMinutes").value(480));
  }

  @Test
  void aDefinitionNeedsAtLeastOneStep() throws Exception {
    mvc.perform(
            post("/api/v1/admin/definitions")
                .header("Authorization", ADMIN_AUTH)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"name\":\"Expenses\",\"steps\":[]}"))
        .andExpect(status().isBadRequest())
        .andExpect(jsonPath("$.type").value("urn:workflow:problem:validation-failed"));
  }

  @Test
  void aPublishedDefinitionCannotBePublishedAgain() throws Exception {
    long approver = data.user("Tomas Vale");
    long id = idFrom(createDraft("Expenses", stepJson(approver)));
    mvc.perform(
            post("/api/v1/admin/definitions/" + id + "/publish")
                .header("Authorization", ADMIN_AUTH))
        .andExpect(status().isOk());

    mvc.perform(
            post("/api/v1/admin/definitions/" + id + "/publish")
                .header("Authorization", ADMIN_AUTH))
        .andExpect(status().isConflict())
        .andExpect(jsonPath("$.type").value("urn:workflow:problem:conflict"));
  }

  @Test
  void eachNameCountsItsOwnVersions() throws Exception {
    long approver = data.user("Tomas Vale");
    long first = idFrom(createDraft("Expenses", stepJson(approver)));
    mvc.perform(
        post("/api/v1/admin/definitions/" + first + "/publish")
            .header("Authorization", ADMIN_AUTH));

    MvcResult second = createDraft("Expenses", stepJson(approver));

    long secondId = idFrom(second);
    mvc.perform(get("/api/v1/admin/definitions/" + secondId).header("Authorization", ADMIN_AUTH))
        .andExpect(jsonPath("$.version").value(2));
  }

  @Test
  void unknownApproverIsNotFound() throws Exception {
    mvc.perform(
            post("/api/v1/admin/definitions")
                .header("Authorization", ADMIN_AUTH)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"name\":\"Expenses\",\"steps\":[" + stepJson(999_999L) + "]}"))
        .andExpect(status().isNotFound())
        .andExpect(jsonPath("$.type").value("urn:workflow:problem:not-found"));
  }

  @Test
  void usersListOnlyPublishedDefinitions() throws Exception {
    long approver = data.user("Tomas Vale");
    createDraft("Draft only", stepJson(approver));
    data.publish("Expenses", TestData.step(1, StepKind.SINGLE, approver, null, 0, 480));
    String token = data.bearer(approver);

    mvc.perform(get("/api/v1/definitions").header("Authorization", token))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.length()").value(1))
        .andExpect(jsonPath("$[0].name").value("Expenses"));
  }

  @Test
  void theAdminRoutesRefuseUserTokens() throws Exception {
    long approver = data.user("Tomas Vale");
    mvc.perform(
            post("/api/v1/admin/definitions")
                .header("Authorization", data.bearer(approver))
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"name\":\"Expenses\",\"steps\":[" + stepJson(approver) + "]}"))
        .andExpect(status().isUnauthorized())
        .andExpect(header().string("WWW-Authenticate", "Bearer"));
  }
}
