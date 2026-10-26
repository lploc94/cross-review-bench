package com.papertrail.workflow.api;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.papertrail.workflow.domain.StepKind;
import com.papertrail.workflow.support.IntegrationTestBase;
import com.papertrail.workflow.support.TestData;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;

class PermissionApiTest extends IntegrationTestBase {

  private static final String AUTH = "Authorization";

  private long owner;
  private long approver;
  private long viewer;
  private long stranger;
  private long document;

  @BeforeEach
  void setUp() throws Exception {
    owner = data.user("Ines Berg");
    approver = data.user("Tomas Vale");
    viewer = data.user("Nadia Roy");
    stranger = data.user("Omar Lind");
    data.publish("Expenses", TestData.step(1, StepKind.SINGLE, approver, null, 0, 480));
    document = data.draft(data.principal(owner), "Expenses", "Travel claim");
  }

  private void grant(long userId, String level) throws Exception {
    mvc.perform(
            put("/api/v1/documents/" + document + "/permissions/" + userId)
                .header(AUTH, data.bearer(owner))
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"level\":\"" + level + "\"}"))
        .andExpect(status().isNoContent());
  }

  @Test
  void aGrantedViewerSeesTheDocumentInListsAndCounts() throws Exception {
    mvc.perform(get("/api/v1/documents/count").header(AUTH, data.bearer(viewer)))
        .andExpect(jsonPath("$.count").value(0));

    grant(viewer, "VIEW");

    mvc.perform(get("/api/v1/documents").header(AUTH, data.bearer(viewer)))
        .andExpect(jsonPath("$.items.length()").value(1))
        .andExpect(jsonPath("$.items[0].title").value("Travel claim"));
    mvc.perform(get("/api/v1/documents/count").header(AUTH, data.bearer(viewer)))
        .andExpect(jsonPath("$.count").value(1));
  }

  @Test
  void aViewerCannotGrantAccessToOthers() throws Exception {
    grant(viewer, "VIEW");

    mvc.perform(
            put("/api/v1/documents/" + document + "/permissions/" + stranger)
                .header(AUTH, data.bearer(viewer))
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"level\":\"COMMENT\"}"))
        .andExpect(status().isForbidden());
  }

  @Test
  void revokingHidesTheDocumentAgain() throws Exception {
    grant(viewer, "VIEW");

    mvc.perform(
            delete("/api/v1/documents/" + document + "/permissions/" + viewer)
                .header(AUTH, data.bearer(owner)))
        .andExpect(status().isNoContent());

    mvc.perform(get("/api/v1/documents/" + document).header(AUTH, data.bearer(viewer)))
        .andExpect(status().isNotFound());
  }

  @Test
  void theOwnerAlreadyHasAccess() throws Exception {
    mvc.perform(
            put("/api/v1/documents/" + document + "/permissions/" + owner)
                .header(AUTH, data.bearer(owner))
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"level\":\"VIEW\"}"))
        .andExpect(status().isBadRequest());
  }

  @Test
  void theOwnerSeesTheGrantsOnTheDocument() throws Exception {
    grant(viewer, "COMMENT");

    mvc.perform(
            get("/api/v1/documents/" + document + "/permissions").header(AUTH, data.bearer(owner)))
        .andExpect(jsonPath("$[0].userId").value(viewer))
        .andExpect(jsonPath("$[0].level").value("COMMENT"));
  }
}
