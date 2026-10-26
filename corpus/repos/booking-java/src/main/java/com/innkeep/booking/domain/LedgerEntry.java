package com.innkeep.booking.domain;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.math.BigDecimal;
import java.time.Instant;

/** One money movement against a reservation: the charge at confirmation, refunds on cancel. */
@Entity
@Table(name = "ledger_entry")
public class LedgerEntry extends AbstractEntity<Long> {

  @Id
  @GeneratedValue(strategy = GenerationType.IDENTITY)
  private Long id;

  @Column(name = "reservation_id", nullable = false)
  private long reservationId;

  @Enumerated(EnumType.STRING)
  @Column(nullable = false, length = 16)
  private LedgerKind kind;

  @Column(nullable = false, precision = 12, scale = 2)
  private BigDecimal amount;

  @Column(nullable = false, length = 3)
  private String currency;

  @Column(nullable = false, length = 120)
  private String reason;

  @Column(name = "gateway_reference", nullable = false, length = 120)
  private String gatewayReference;

  @Column(name = "created_at", nullable = false)
  private Instant createdAt;

  protected LedgerEntry() {}

  public LedgerEntry(
      long reservationId,
      LedgerKind kind,
      Money amount,
      String reason,
      String gatewayReference,
      Instant createdAt) {
    this.reservationId = reservationId;
    this.kind = kind;
    this.amount = amount.amount();
    this.currency = amount.currency().getCurrencyCode();
    this.reason = reason;
    this.gatewayReference = gatewayReference;
    this.createdAt = createdAt;
  }

  @Override
  public Long getId() {
    return id;
  }

  public long getReservationId() {
    return reservationId;
  }

  public LedgerKind getKind() {
    return kind;
  }

  public BigDecimal getAmount() {
    return amount;
  }

  public String getReason() {
    return reason;
  }

  public String getGatewayReference() {
    return gatewayReference;
  }

  public Instant getCreatedAt() {
    return createdAt;
  }
}
