package com.papertrail.workflow.api;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.papertrail.workflow.support.IntegrationTestBase;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MvcResult;

/** Drafts belong to the admin routes; the user routes show published versions only. */
class DefinitionVisibilityTest extends IntegrationTestBase {

  private static final String AUTH = "Authorization";

  private static final String DRAFT =
      "{\"name\":\"Travel\",\"steps\":[{\"order\":1,\"kind\":\"SINGLE\",\"assigneeId\":1,"
          + "\"slaMinutes\":480}]}";

  @Test
  void aDraftIsNotReadOnTheUserRoute() throws Exception {
    long owner = data.user("Ines Berg");
    long approver = data.user("Tomas Vale");
    String body = DRAFT.replace("\"assigneeId\":1", "\"assigneeId\":" + approver);
    MvcResult created =
        mvc.perform(
                post("/api/v1/admin/definitions")
                    .header(AUTH, ADMIN_AUTH)
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(body))
            .andExpect(status().isCreated())
            .andReturn();

    mvc.perform(get("/api/v1/definitions/" + idFrom(created)).header(AUTH, data.bearer(owner)))
        .andExpect(status().isNotFound());
    mvc.perform(get("/api/v1/admin/definitions/" + idFrom(created)).header(AUTH, ADMIN_AUTH))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.published").value(false));
  }

  @Test
  void aNewDraftIsLocatedOnTheAdminRoute() throws Exception {
    long approver = data.user("Tomas Vale");
    mvc.perform(
            post("/api/v1/admin/definitions")
                .header(AUTH, ADMIN_AUTH)
                .contentType(MediaType.APPLICATION_JSON)
                .content(DRAFT.replace("\"assigneeId\":1", "\"assigneeId\":" + approver)))
        .andExpect(status().isCreated())
        .andExpect(
            header()
                .string(
                    "Location", org.hamcrest.Matchers.startsWith("/api/v1/admin/definitions/")));
  }
}
