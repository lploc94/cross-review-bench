package com.papertrail.workflow.api;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.papertrail.workflow.domain.StepKind;
import com.papertrail.workflow.support.IntegrationTestBase;
import com.papertrail.workflow.support.TestData;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;

/** Who receives a notification is decided by the account, never by an address that can change. */
class NotificationOwnershipTest extends IntegrationTestBase {

  private static final String AUTH = "Authorization";

  @Test
  void aSecondAccountCannotTakeAnAddressInUse() throws Exception {
    data.user("Ines Berg"); // ines.berg@example.com

    mvc.perform(
            post("/api/v1/admin/users")
                .header(AUTH, ADMIN_AUTH)
                .contentType(MediaType.APPLICATION_JSON)
                .content(
                    "{\"displayName\":\"Ines Again\",\"email\":\"INES.BERG@example.com\","
                        + "\"admin\":false}"))
        .andExpect(status().isConflict());
  }

  @Test
  void aUserKeepsTheirNotificationsWhenTheirAddressChanges() throws Exception {
    long owner = data.user("Ines Berg");
    long approver = data.user("Tomas Vale");
    data.publish("Contract", TestData.step(1, StepKind.SINGLE, approver, null, 0, 480));
    long document = data.draft(data.principal(owner), "Contract", "Supplier contract");
    mvc.perform(post("/api/v1/documents/" + document + "/submit").header(AUTH, data.bearer(owner)))
        .andExpect(status().isNoContent());

    mvc.perform(
            patch("/api/v1/admin/users/" + approver)
                .header(AUTH, ADMIN_AUTH)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"email\":\"tomas.new@example.com\"}"))
        .andExpect(status().isOk());

    mvc.perform(get("/api/v1/notifications/mine").header(AUTH, data.bearer(approver)))
        .andExpect(jsonPath("$.items[0].eventType").value("TASK_ASSIGNED"));
  }
}
