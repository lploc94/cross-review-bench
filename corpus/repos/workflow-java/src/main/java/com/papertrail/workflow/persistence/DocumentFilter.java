package com.papertrail.workflow.persistence;

import com.papertrail.workflow.domain.DocumentStatus;

/**
 * Optional narrowing of a document list or count. A null field is not applied, so the empty filter
 * selects every document the caller may see. {@code sharedWithMe} keeps only the documents the
 * owner granted to the caller explicitly.
 */
public record DocumentFilter(
    DocumentStatus status, Long ownerId, String definitionName, boolean sharedWithMe) {

  public static final DocumentFilter NONE = new DocumentFilter(null, null, null);

  public DocumentFilter(DocumentStatus status, Long ownerId, String definitionName) {
    this(status, ownerId, definitionName, false);
  }
}
