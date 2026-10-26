package com.papertrail.workflow.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart;

import com.papertrail.workflow.domain.Decision;
import com.papertrail.workflow.domain.PermissionLevel;
import com.papertrail.workflow.domain.StepKind;
import com.papertrail.workflow.service.ApprovalService;
import com.papertrail.workflow.service.DocumentService;
import com.papertrail.workflow.service.PermissionService;
import com.papertrail.workflow.support.IntegrationTestBase;
import com.papertrail.workflow.support.TestData;
import java.nio.charset.StandardCharsets;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.web.servlet.MvcResult;

class AttachmentRulesCheckTest extends IntegrationTestBase {

  private static final String AUTH = "Authorization";
  private static final byte[] NOTE = "Invented invoice 7".getBytes(StandardCharsets.UTF_8);

  @Autowired private DocumentService documents;
  @Autowired private PermissionService permissions;
  @Autowired private ApprovalService approvals;

  private long owner;
  private long approver;
  private long document;

  @BeforeEach
  void setUp() {
    owner = data.user("Hanna Lorne");
    approver = data.user("Felix Arden");
    data.publish("Invoices", TestData.step(1, StepKind.SINGLE, approver, null, 0, 240));
    document = data.draft(data.principal(owner), "Invoices", "Printer toner");
  }

  private String path(long doc) {
    return "/api/v1/documents/" + doc + "/attachments";
  }

  private MvcResult upload(long doc, long userId, String type, byte[] content) throws Exception {
    return mvc.perform(
            multipart(path(doc))
                .file(new MockMultipartFile("file", "invoice.pdf", type, content))
                .header(AUTH, data.bearer(userId)))
        .andReturn();
  }

  private int status(MvcResult result) {
    return result.getResponse().getStatus();
  }

  private int stored() {
    return jdbc.queryForObject("select count(*) from document_attachment", Integer.class);
  }

  @Test
  void sizeCountAndTypeLimitsHoldAtTheirBounds() throws Exception {
    MvcResult tooLarge = upload(document, owner, "application/pdf", new byte[4097]);
    assertThat(status(tooLarge)).isEqualTo(413);
    assertThat(tooLarge.getResponse().getContentAsString())
        .contains("urn:workflow:problem:too-large");
    assertThat(status(upload(document, owner, "image/svg+xml", NOTE))).isEqualTo(415);
    assertThat(stored()).isZero();

    long first = idFrom(upload(document, owner, "application/pdf", new byte[4096]));
    MvcResult png = upload(document, owner, "IMAGE/PNG; q=1", NOTE);
    assertThat(status(png)).isEqualTo(201);
    assertThat(png.getResponse().getContentAsString()).contains("\"contentType\":\"image/png\"");
    assertThat(status(upload(document, owner, "text/plain", NOTE))).isEqualTo(201);
    MvcResult fourth = upload(document, owner, "text/plain", NOTE);
    assertThat(status(fourth)).isEqualTo(409);
    assertThat(stored()).isEqualTo(3);

    mvc.perform(delete(path(document) + "/" + first).header(AUTH, data.bearer(owner)));
    assertThat(status(upload(document, owner, "text/plain", NOTE))).isEqualTo(201);
    assertThat(stored()).isEqualTo(3);
  }

  @Test
  void downloadsFollowTheDocumentsVisibility() throws Exception {
    long id = idFrom(upload(document, owner, "application/pdf", NOTE));
    long commenter = data.user("Lydia Brack");
    long stranger = data.user("Jonas Pell");
    long admin = data.admin("Clara Voss");
    permissions.grant(data.principal(owner), document, commenter, PermissionLevel.COMMENT);
    long other = data.draft(data.principal(stranger), "Invoices", "Desk lamp");

    assertThat(statusFor(approver, path(document) + "/" + id)).isEqualTo(404);
    documents.submit(data.principal(owner), document);

    assertThat(statusFor(approver, path(document) + "/" + id)).isEqualTo(200);
    assertThat(statusFor(commenter, path(document) + "/" + id)).isEqualTo(200);
    assertThat(statusFor(admin, path(document) + "/" + id)).isEqualTo(200);
    assertThat(statusFor(stranger, path(document) + "/" + id)).isEqualTo(404);
    assertThat(statusFor(stranger, path(document))).isEqualTo(404);
    assertThat(statusFor(stranger, path(other) + "/" + id)).isEqualTo(404);
    MvcResult content =
        mvc.perform(get(path(document) + "/" + id).header(AUTH, data.bearer(commenter)))
            .andReturn();
    assertThat(content.getResponse().getContentAsByteArray()).isEqualTo(NOTE);
    assertThat(content.getResponse().getContentType()).isEqualTo("application/pdf");
  }

  private int statusFor(long userId, String url) throws Exception {
    return mvc.perform(get(url).header(AUTH, data.bearer(userId)))
        .andReturn()
        .getResponse()
        .getStatus();
  }

  @Test
  void filesAreLockedOnceSubmittedAlsoAfterWithdrawalOrRejection() throws Exception {
    long kept = idFrom(upload(document, owner, "text/plain", NOTE));
    documents.submit(data.principal(owner), document);

    assertThat(status(upload(document, owner, "text/plain", NOTE))).isEqualTo(409);
    assertThat(
            mvc.perform(delete(path(document) + "/" + kept).header(AUTH, data.bearer(owner)))
                .andReturn()
                .getResponse()
                .getStatus())
        .isEqualTo(409);

    approvals.decide(
        data.principal(approver), taskOf(document, approver), Decision.REJECT, "Wrong vendor");
    assertThat(status(upload(document, owner, "text/plain", NOTE))).isEqualTo(409);

    long second = data.draft(data.principal(owner), "Invoices", "Paper");
    idFrom(upload(second, owner, "text/plain", NOTE));
    documents.submit(data.principal(owner), second);
    documents.withdraw(data.principal(owner), second);
    MvcResult afterWithdraw = upload(second, owner, "text/plain", NOTE);
    assertThat(status(afterWithdraw)).isEqualTo(409);
    assertThat(afterWithdraw.getResponse().getContentAsString())
        .contains("urn:workflow:problem:invalid-transition");
    assertThat(stored()).isEqualTo(2);
  }
}
