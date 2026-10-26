package com.papertrail.workflow.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.papertrail.workflow.domain.PermissionLevel;
import com.papertrail.workflow.domain.StepKind;
import com.papertrail.workflow.service.DocumentService;
import com.papertrail.workflow.service.PermissionService;
import com.papertrail.workflow.support.IntegrationTestBase;
import com.papertrail.workflow.support.TestData;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

/** The search total counts only documents the caller may see, as the results do. */
class TitleSearchTotalScopeTest extends IntegrationTestBase {

  private static final String AUTH = "Authorization";

  @Autowired private DocumentService documents;
  @Autowired private PermissionService permissions;
  @Autowired private ObjectMapper json;

  private long owner;
  private long approver;
  private long stranger;

  @BeforeEach
  void setUp() {
    owner = data.user("Ines Berg");
    approver = data.user("Tomas Vale");
    stranger = data.user("Omar Lind");
    data.publish("Contract", TestData.step(1, StepKind.SINGLE, approver, null, 0, 480));
    data.draft(data.principal(owner), "Contract", "Merger with Halvorsen Freight");
    data.draft(data.principal(owner), "Contract", "Merger due diligence");
    data.draft(data.principal(owner), "Contract", "Merger press statement");
  }

  private JsonNode search(long caller, String query, int size) throws Exception {
    String body =
        mvc.perform(
                get("/api/v1/documents/search")
                    .param("q", query)
                    .param("size", String.valueOf(size))
                    .header(AUTH, data.bearer(caller)))
            .andExpect(status().isOk())
            .andReturn()
            .getResponse()
            .getContentAsString();
    return json.readTree(body);
  }

  @Test
  void aStrangerLearnsNothingAboutOthersMatches() throws Exception {
    JsonNode page = search(stranger, "merger", 20);

    assertThat(page.get("items")).isEmpty();
    assertThat(page.get("total").asLong()).isZero();
    assertThat(search(stranger, "halvorsen", 20).get("total").asLong()).isZero();
  }

  @Test
  void theTotalOfAFullPageCountsOnlyVisibleMatches() throws Exception {
    data.draft(data.principal(stranger), "Contract", "Merger reading list");
    data.draft(data.principal(stranger), "Contract", "Merger talk notes");

    JsonNode page = search(stranger, "merger", 1);

    assertThat(page.get("items")).hasSize(1);
    assertThat(page.get("nextCursor").isNull()).isFalse();
    assertThat(page.get("total").asLong()).isEqualTo(2);
  }

  @Test
  void grantsAndTasksAreCountedLikeTheResults() throws Exception {
    long shared = data.draft(data.principal(owner), "Contract", "Merger board minutes");
    permissions.grant(data.principal(owner), shared, stranger, PermissionLevel.VIEW);
    long submitted = data.draft(data.principal(owner), "Contract", "Merger budget");
    documents.submit(data.principal(owner), submitted);

    assertThat(search(stranger, "merger", 1).get("total").asLong()).isEqualTo(1);
    assertThat(search(approver, "merger", 1).get("total").asLong()).isEqualTo(1);
    assertThat(search(owner, "merger", 1).get("total").asLong()).isEqualTo(5);
  }
}
