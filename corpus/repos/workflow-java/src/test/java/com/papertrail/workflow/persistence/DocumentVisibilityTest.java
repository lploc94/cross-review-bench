package com.papertrail.workflow.persistence;

import static org.assertj.core.api.Assertions.assertThat;

import com.papertrail.workflow.domain.DocumentStatus;
import com.papertrail.workflow.domain.PermissionLevel;
import com.papertrail.workflow.domain.Principal;
import com.papertrail.workflow.domain.StepKind;
import com.papertrail.workflow.service.DocumentService;
import com.papertrail.workflow.service.PermissionService;
import com.papertrail.workflow.service.Views.DocumentSummary;
import com.papertrail.workflow.service.Views.PageView;
import com.papertrail.workflow.support.IntegrationTestBase;
import com.papertrail.workflow.support.TestData;
import java.util.HashSet;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

/** Lists and counts show a document only to the people the permission rule allows. */
class DocumentVisibilityTest extends IntegrationTestBase {

  @Autowired private DocumentService documents;
  @Autowired private PermissionService permissions;

  @Test
  void listsAndCountsFilterByPermission() {
    long owner = data.user("Ines Berg");
    long approver = data.user("Tomas Vale");
    long viewer = data.user("Nadia Roy");
    long stranger = data.user("Omar Lind");
    data.publish("Expenses", TestData.step(1, StepKind.SINGLE, approver, null, 0, 480));
    long reviewed = data.draft(data.principal(owner), "Expenses", "Reviewed claim");
    documents.submit(data.principal(owner), reviewed);
    long granted = data.draft(data.principal(owner), "Expenses", "Shared claim");
    permissions.grant(data.principal(owner), granted, viewer, PermissionLevel.VIEW);
    data.draft(data.principal(owner), "Expenses", "Private draft");

    assertThat(titles(data.principal(owner))).hasSize(3);
    assertThat(titles(data.principal(approver))).containsExactly("Reviewed claim");
    assertThat(titles(data.principal(viewer))).containsExactly("Shared claim");
    assertThat(titles(data.principal(stranger))).isEmpty();
    assertThat(documents.count(data.principal(stranger), DocumentFilter.NONE)).isZero();
    assertThat(
            documents.count(
                data.principal(owner), new DocumentFilter(DocumentStatus.DRAFT, null, null)))
        .isEqualTo(2);
  }

  @Test
  void adminsSeeEverything() {
    long owner = data.user("Ines Berg");
    data.publish("Expenses", TestData.step(1, StepKind.SINGLE, owner, null, 0, 480));
    data.draft(data.principal(owner), "Expenses", "Private draft");
    long admin = data.admin("Ops Admin");

    assertThat(documents.count(data.principal(admin), DocumentFilter.NONE)).isEqualTo(1);
  }

  @Test
  void keysetPagesCoverEveryDocumentOnce() {
    long owner = data.user("Ines Berg");
    data.publish("Expenses", TestData.step(1, StepKind.SINGLE, owner, null, 0, 480));
    for (int i = 0; i < 5; i++) {
      data.draft(data.principal(owner), "Expenses", "Claim " + i);
    }
    Principal me = data.principal(owner);
    var seen = new HashSet<Long>();
    Long cursor = null;
    int pages = 0;
    do {
      PageView<DocumentSummary> page = documents.list(me, DocumentFilter.NONE, cursor, 2);
      page.items().forEach(item -> assertThat(seen.add(item.id())).isTrue());
      cursor = page.nextCursor();
      pages++;
    } while (cursor != null);

    assertThat(seen).hasSize(5);
    assertThat(pages).isEqualTo(3);
  }

  private List<String> titles(Principal principal) {
    return documents.list(principal, DocumentFilter.NONE, null, 50).items().stream()
        .map(DocumentSummary::title)
        .toList();
  }
}
