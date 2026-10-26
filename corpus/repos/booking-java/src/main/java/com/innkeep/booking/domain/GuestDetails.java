package com.innkeep.booking.domain;

import jakarta.persistence.Column;
import jakarta.persistence.Embeddable;
import java.util.Locale;

/** The guest a hold or reservation is for. Email is stored trimmed and lower-cased. */
@Embeddable
public class GuestDetails {

  @Column(name = "guest_name", nullable = false, length = 120)
  private String name;

  @Column(name = "guest_email", nullable = false, length = 254)
  private String email;

  @Column(name = "guest_phone", length = 32)
  private String phone;

  protected GuestDetails() {}

  public GuestDetails(String name, String email, String phone) {
    this.name = name.trim();
    this.email = email.trim().toLowerCase(Locale.ROOT);
    this.phone = phone == null || phone.isBlank() ? null : phone.trim();
  }

  public String getName() {
    return name;
  }

  public String getEmail() {
    return email;
  }

  public String getPhone() {
    return phone;
  }

  /** Contact details never appear in logs or exception messages. */
  @Override
  public String toString() {
    return "GuestDetails[redacted]";
  }
}
