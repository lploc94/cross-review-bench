package com.papertrail.workflow.service;

import static org.assertj.core.api.Assertions.assertThat;

import com.papertrail.workflow.domain.Decision;
import com.papertrail.workflow.domain.Document;
import com.papertrail.workflow.domain.StepKind;
import com.papertrail.workflow.integration.ArchiveJob;
import com.papertrail.workflow.support.IntegrationTestBase;
import com.papertrail.workflow.support.TestData;
import java.time.Duration;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.test.context.TestPropertySource;

@TestPropertySource(
    properties = {
      "workflow.retention.finished-after=PT0S",
      "workflow.retention.resubmit-window=P30D"
    })
class RejectedRetentionWindowTest extends IntegrationTestBase {

  @Autowired private DocumentService documents;
  @Autowired private ApprovalService approvals;
  @Autowired private ArchiveJob job;

  private long rejected(long owner, long approver, String title) {
    long id = data.draft(data.principal(owner), "Contract", title);
    documents.submit(data.principal(owner), id);
    approvals.decide(data.principal(approver), taskOf(id, approver), Decision.REJECT, null);
    return id;
  }

  private String body(long id) {
    return jdbc.queryForObject("select body from document where id = ?", String.class, id);
  }

  @Test
  void aRejectionInsideItsResubmitWindowKeepsItsText() {
    long owner = data.user("Ines Berg");
    long approver = data.user("Tomas Vale");
    data.publish("Contract", TestData.step(1, StepKind.SINGLE, approver, null, 0, 480));
    long recent = rejected(owner, approver, "Supplier contract");

    clock.advance(Duration.ofDays(1));
    job.runOnce();

    assertThat(body(recent)).isEqualTo("Invented body text for Supplier contract");
    documents.resubmit(data.principal(owner), recent);
    assertThat(body(recent)).isEqualTo("Invented body text for Supplier contract");
  }

  @Test
  void aRejectionIsArchivedOnceItsResubmitWindowHasClosed() {
    long owner = data.user("Ines Berg");
    long approver = data.user("Tomas Vale");
    data.publish("Contract", TestData.step(1, StepKind.SINGLE, approver, null, 0, 480));
    long rejection = rejected(owner, approver, "Supplier contract");

    clock.advance(Duration.ofDays(29));
    job.runOnce();
    assertThat(body(rejection)).isEqualTo("Invented body text for Supplier contract");

    clock.advance(Duration.ofDays(1));
    job.runOnce();
    assertThat(body(rejection)).isEqualTo(Document.ARCHIVED_BODY);
  }
}
