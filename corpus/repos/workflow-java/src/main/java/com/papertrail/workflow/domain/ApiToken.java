package com.papertrail.workflow.domain;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.FetchType;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.JoinColumn;
import jakarta.persistence.ManyToOne;
import jakarta.persistence.Table;
import java.time.Instant;

/**
 * A user's API token. The plaintext is shown once at issue time; only its SHA-256 hash and the
 * eight-character lookup prefix are stored.
 */
@Entity
@Table(name = "api_token")
public class ApiToken extends AbstractEntity<Long> {

  @Id
  @GeneratedValue(strategy = GenerationType.IDENTITY)
  private Long id;

  @ManyToOne(fetch = FetchType.LAZY, optional = false)
  @JoinColumn(name = "user_id", nullable = false)
  private AppUser user;

  @Column(nullable = false, unique = true, length = 8)
  private String prefix;

  @Column(name = "secret_hash", nullable = false, length = 64)
  private String secretHash;

  @Column(name = "created_at", nullable = false)
  private Instant createdAt;

  @Column(name = "revoked_at")
  private Instant revokedAt;

  protected ApiToken() {}

  public ApiToken(AppUser user, String prefix, String secretHash, Instant createdAt) {
    this.user = user;
    this.prefix = prefix;
    this.secretHash = secretHash;
    this.createdAt = createdAt;
  }

  @Override
  public Long getId() {
    return id;
  }

  public AppUser getUser() {
    return user;
  }

  public String getPrefix() {
    return prefix;
  }

  public String getSecretHash() {
    return secretHash;
  }

  public Instant getCreatedAt() {
    return createdAt;
  }

  public Instant getRevokedAt() {
    return revokedAt;
  }

  public boolean isRevoked() {
    return revokedAt != null;
  }

  public void revoke(Instant now) {
    if (revokedAt == null) {
      this.revokedAt = now;
    }
  }
}
