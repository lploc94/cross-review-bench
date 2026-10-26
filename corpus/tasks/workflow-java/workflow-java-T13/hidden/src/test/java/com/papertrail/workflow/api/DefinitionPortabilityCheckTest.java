package com.papertrail.workflow.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.papertrail.workflow.domain.StepKind;
import com.papertrail.workflow.service.DocumentService;
import com.papertrail.workflow.support.IntegrationTestBase;
import com.papertrail.workflow.support.TestData;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MvcResult;

class DefinitionPortabilityCheckTest extends IntegrationTestBase {

  @Autowired private ObjectMapper json;
  @Autowired private DocumentService documents;

  private JsonNode export(long id) throws Exception {
    MvcResult result =
        mvc.perform(
                get("/api/v1/admin/definitions/" + id + "/export")
                    .header("Authorization", ADMIN_AUTH))
            .andReturn();
    assertThat(result.getResponse().getStatus()).isEqualTo(200);
    return json.readTree(result.getResponse().getContentAsString());
  }

  private MvcResult importBody(String body) throws Exception {
    return mvc.perform(
            post("/api/v1/admin/definitions/import")
                .header("Authorization", ADMIN_AUTH)
                .contentType(MediaType.APPLICATION_JSON)
                .content(body))
        .andReturn();
  }

  private int count(String table) {
    return jdbc.queryForObject("select count(*) from " + table, Integer.class);
  }

  @Test
  void aRoundTripKeepsParallelStepsKindsGroupsAndSlas() throws Exception {
    long single = data.user("Ilsa Morrow");
    long a = data.user("Pavel Durand");
    long b = data.user("Rosa Lind");
    long c = data.user("Omar Keel");
    long owner = data.user("Nadia Fern");
    long reviewers = data.group("reviewers", a, b);
    long board = data.group("board", a, b, c);
    long source =
        data.publish(
            "Purchases",
            TestData.step(1, StepKind.SINGLE, single, null, 0, 45),
            TestData.step(1, StepKind.ANY_OF, null, reviewers, 0, 480),
            TestData.step(2, StepKind.ALL_OF, null, board, 0, 2880),
            TestData.step(3, StepKind.QUORUM, null, board, 2, 61));
    JsonNode exported = export(source);
    ObjectNode copy = exported.deepCopy();
    copy.remove("version");

    MvcResult created = importBody(copy.toString());

    assertThat(created.getResponse().getStatus()).isEqualTo(201);
    long imported = idFrom(created);
    JsonNode again = export(imported);
    assertThat(again.get("name")).isEqualTo(exported.get("name"));
    assertThat(again.get("version").asInt()).isEqualTo(2);
    assertThat(again.get("steps")).isEqualTo(exported.get("steps"));
    assertThat(again.get("steps").get(2).get("sla").asText()).isEqualTo("PT48H");

    mvc.perform(
        post("/api/v1/admin/definitions/" + imported + "/publish")
            .header("Authorization", ADMIN_AUTH));
    long document = data.draft(data.principal(owner), "Purchases", "Office chairs");
    documents.submit(data.principal(owner), document);
    assertThat(
            jdbc.queryForObject(
                "select d.version from document doc join workflow_definition d"
                    + " on d.id = doc.definition_id where doc.id = ?",
                Integer.class,
                document))
        .isEqualTo(2);
    assertThat(
            jdbc.queryForObject(
                "select count(*) from approval_task where document_id = ?",
                Integer.class,
                document))
        .isEqualTo(3);
  }

  @Test
  void anUnknownGroupInALaterStepIsNamedAndNothingIsCreated() throws Exception {
    data.user("Ilsa Morrow");
    data.group("reviewers", data.user("Rosa Lind"));
    String body =
        """
        {"name":"Purchases","steps":[
          {"order":1,"kind":"SINGLE","assignee":"ilsa.morrow@example.com","quorum":0,"sla":"PT1H"},
          {"order":2,"kind":"ANY_OF","group":"reviewers","quorum":0,"sla":"PT1H"},
          {"order":3,"kind":"ALL_OF","group":"procurement","quorum":0,"sla":"PT1H"}]}""";

    MvcResult result = importBody(body);

    assertThat(result.getResponse().getStatus()).isEqualTo(400);
    JsonNode problem = json.readTree(result.getResponse().getContentAsString());
    assertThat(problem.get("type").asText()).isEqualTo("urn:workflow:problem:invalid-request");
    assertThat(problem.get("detail").asText()).contains("procurement");
    assertThat(count("workflow_definition")).isZero();
    assertThat(count("step_definition")).isZero();
  }

  @Test
  void aNameAndVersionThatClashAreAConflictAndOtherVersionsAreNot() throws Exception {
    long approver = data.user("Ilsa Morrow");
    long first =
        data.publish("Purchases", TestData.step(1, StepKind.SINGLE, approver, null, 0, 60));
    mvc.perform(
        post("/api/v1/admin/definitions/" + first + "/revise").header("Authorization", ADMIN_AUTH));
    ObjectNode file = export(first).deepCopy();

    file.put("version", 2);
    assertThat(importBody(file.toString()).getResponse().getStatus()).isEqualTo(409);
    file.put("version", 1);
    assertThat(importBody(file.toString()).getResponse().getStatus()).isEqualTo(409);
    assertThat(count("workflow_definition")).isEqualTo(2);

    file.put("version", 3);
    long third = idFrom(importBody(file.toString()));
    assertThat(export(third).get("version").asInt()).isEqualTo(3);

    file.put("name", "Travel");
    file.put("version", 2);
    long travel = idFrom(importBody(file.toString()));
    assertThat(export(travel).get("version").asInt()).isEqualTo(2);

    file.remove("version");
    file.put("name", "Purchases");
    long next = idFrom(importBody(file.toString()));
    assertThat(export(next).get("version").asInt()).isEqualTo(4);
  }
}
