package com.papertrail.workflow.domain;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.util.Locale;

/** A person who signs in with an API token and may own, review or approve documents. */
@Entity
@Table(name = "app_user")
public class AppUser extends AbstractEntity<Long> {

  @Id
  @GeneratedValue(strategy = GenerationType.IDENTITY)
  private Long id;

  @Column(name = "display_name", nullable = false, length = 120)
  private String displayName;

  @Column(nullable = false, length = 254)
  private String email;

  @Column(nullable = false)
  private boolean active;

  @Column(nullable = false)
  private boolean admin;

  protected AppUser() {}

  public AppUser(String displayName, String email, boolean admin) {
    this.displayName = requireText(displayName, "displayName", 120);
    this.email = normaliseEmail(email);
    this.active = true;
    this.admin = admin;
  }

  public static String normaliseEmail(String raw) {
    String value = requireText(raw, "email", 254).toLowerCase(Locale.ROOT);
    int at = value.indexOf('@');
    if (at < 1 || at == value.length() - 1 || value.indexOf('@', at + 1) >= 0) {
      throw new ValidationException("email must look like name@example.com");
    }
    return value;
  }

  static String requireText(String value, String field, int max) {
    if (value == null || value.isBlank()) {
      throw new ValidationException(field + " is required");
    }
    String trimmed = value.trim();
    if (trimmed.length() > max) {
      throw new ValidationException(field + " may not exceed " + max + " characters");
    }
    return trimmed;
  }

  @Override
  public Long getId() {
    return id;
  }

  public String getDisplayName() {
    return displayName;
  }

  public String getEmail() {
    return email;
  }

  public boolean isActive() {
    return active;
  }

  public boolean isAdmin() {
    return admin;
  }

  public void activate() {
    this.active = true;
  }

  public void deactivate() {
    this.active = false;
  }

  /** Changes the name and email; a null argument keeps the current value. */
  public void changeProfile(String newDisplayName, String newEmail) {
    if (newDisplayName != null) {
      this.displayName = requireText(newDisplayName, "displayName", 120);
    }
    if (newEmail != null) {
      this.email = normaliseEmail(newEmail);
    }
  }
}
