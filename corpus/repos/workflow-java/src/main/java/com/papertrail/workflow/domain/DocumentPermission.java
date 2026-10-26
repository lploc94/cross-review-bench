package com.papertrail.workflow.domain;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.FetchType;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.JoinColumn;
import jakarta.persistence.ManyToOne;
import jakarta.persistence.Table;
import java.time.Instant;

/** A level the owner explicitly granted a user on one document. */
@Entity
@Table(name = "document_permission")
public class DocumentPermission extends AbstractEntity<Long> {

  @Id
  @GeneratedValue(strategy = GenerationType.IDENTITY)
  private Long id;

  @ManyToOne(fetch = FetchType.LAZY, optional = false)
  @JoinColumn(name = "document_id", nullable = false)
  private Document document;

  @ManyToOne(fetch = FetchType.LAZY, optional = false)
  @JoinColumn(name = "user_id", nullable = false)
  private AppUser user;

  @Enumerated(EnumType.STRING)
  @Column(nullable = false, length = 16)
  private PermissionLevel level;

  @Column(name = "granted_at", nullable = false)
  private Instant grantedAt;

  protected DocumentPermission() {}

  public DocumentPermission(
      Document document, AppUser user, PermissionLevel level, Instant grantedAt) {
    this.document = document;
    this.user = user;
    this.level = level;
    this.grantedAt = grantedAt;
  }

  public void changeLevel(PermissionLevel newLevel, Instant now) {
    this.level = newLevel;
    this.grantedAt = now;
  }

  @Override
  public Long getId() {
    return id;
  }

  public Document getDocument() {
    return document;
  }

  public AppUser getUser() {
    return user;
  }

  public PermissionLevel getLevel() {
    return level;
  }

  public Instant getGrantedAt() {
    return grantedAt;
  }
}
