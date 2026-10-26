package com.papertrail.workflow.service;

import static org.assertj.core.api.Assertions.assertThat;

import com.papertrail.workflow.domain.StepKind;
import com.papertrail.workflow.support.IntegrationTestBase;
import com.papertrail.workflow.support.TestData;
import java.time.LocalDate;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

class OutOfOfficeHandoverCheckTest extends IntegrationTestBase {

  private static final LocalDate MONDAY = LocalDate.of(2027, 5, 3);

  @Autowired private DocumentService documents;
  @Autowired private IdentityService identity;

  private long submit(long owner, String definition) {
    long document = data.draft(data.principal(owner), definition, "Supplier contract");
    documents.submit(data.principal(owner), document);
    return document;
  }

  private List<Map<String, Object>> tasksOf(long document) {
    return jdbc.queryForList(
        "select assignee_id, on_behalf_of_id from approval_task where document_id = ?"
            + " order by id",
        document);
  }

  private static Map<String, Object> row(long assignee, Long onBehalfOf) {
    var row = new HashMap<String, Object>();
    row.put("assignee_id", assignee);
    row.put("on_behalf_of_id", onBehalfOf);
    return row;
  }

  @Test
  void theSubstituteGetsTheTaskOfAnAbsentApprover() {
    long owner = data.user("Mira Holt");
    long approver = data.user("Oskar Lind");
    long substitute = data.user("Petra Sand");
    data.publish("Contracts", TestData.step(1, StepKind.SINGLE, approver, null, 0, 480));
    identity.goAway(approver, MONDAY, MONDAY.plusDays(4), substitute);

    long document = submit(owner, "Contracts");

    assertThat(tasksOf(document)).containsExactly(row(substitute, approver));
  }

  @Test
  void theOwnerAsSubstituteLeavesTheTaskWithTheApprover() {
    long owner = data.user("Mira Holt");
    long approver = data.user("Oskar Lind");
    data.publish("Contracts", TestData.step(1, StepKind.SINGLE, approver, null, 0, 480));
    identity.goAway(approver, MONDAY, MONDAY.plusDays(4), owner);

    long document = submit(owner, "Contracts");

    assertThat(tasksOf(document)).containsExactly(row(approver, null));
  }

  @Test
  void delegationStopsAtTheSubstitutesOwnTask() {
    long owner = data.user("Mira Holt");
    long first = data.user("Oskar Lind");
    long second = data.user("Petra Sand");
    long third = data.user("Rune Dahl");
    long team = data.group("Legal", first, second);
    data.publish("Contracts", TestData.step(1, StepKind.ALL_OF, null, team, 0, 480));
    identity.goAway(first, MONDAY, MONDAY.plusDays(4), second);
    identity.goAway(second, MONDAY, MONDAY.plusDays(4), third);

    long document = submit(owner, "Contracts");

    assertThat(tasksOf(document)).containsExactly(row(first, null), row(third, second));
  }
}
