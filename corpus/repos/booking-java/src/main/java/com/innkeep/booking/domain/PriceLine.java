package com.innkeep.booking.domain;

import jakarta.persistence.Column;
import jakarta.persistence.Embeddable;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import java.math.BigDecimal;
import java.time.LocalDate;

/**
 * One line of a price breakdown. Quotes and reservations keep their own copy of the lines, so a
 * later change to the rules never changes what a guest was quoted or charged.
 */
@Embeddable
public class PriceLine {

  @Enumerated(EnumType.STRING)
  @Column(nullable = false, length = 32)
  private PriceKind kind;

  @Column(name = "night")
  private LocalDate night;

  @Column(nullable = false, length = 160)
  private String description;

  @Column(nullable = false, precision = 12, scale = 2)
  private BigDecimal amount;

  protected PriceLine() {}

  public PriceLine(PriceKind kind, LocalDate night, String description, BigDecimal amount) {
    this.kind = kind;
    this.night = night;
    this.description = description;
    this.amount = amount;
  }

  public PriceKind getKind() {
    return kind;
  }

  /** The night the line belongs to, or null for a stay-level line. */
  public LocalDate getNight() {
    return night;
  }

  public String getDescription() {
    return description;
  }

  public BigDecimal getAmount() {
    return amount;
  }
}
