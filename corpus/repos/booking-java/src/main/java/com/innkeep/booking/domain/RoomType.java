package com.innkeep.booking.domain;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.FetchType;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.JoinColumn;
import jakarta.persistence.ManyToOne;
import jakarta.persistence.Table;
import java.math.BigDecimal;

/** A kind of room a property sells, with its capacity and base nightly rate per room. */
@Entity
@Table(name = "room_type")
public class RoomType extends AbstractEntity<Long> {

  @Id
  @GeneratedValue(strategy = GenerationType.IDENTITY)
  private Long id;

  @ManyToOne(fetch = FetchType.LAZY, optional = false)
  @JoinColumn(name = "property_id", nullable = false)
  private Property property;

  @Column(nullable = false, length = 40)
  private String code;

  @Column(nullable = false, length = 120)
  private String name;

  @Column(nullable = false)
  private int capacity;

  @Column(name = "base_nightly_rate", nullable = false, precision = 12, scale = 2)
  private BigDecimal baseNightlyRate;

  @Column(name = "extra_guest_fee", nullable = false, precision = 12, scale = 2)
  private BigDecimal extraGuestFee;

  protected RoomType() {}

  public RoomType(
      Property property,
      String code,
      String name,
      int capacity,
      BigDecimal baseNightlyRate,
      BigDecimal extraGuestFee) {
    this.property = property;
    this.code = code;
    this.name = name;
    this.capacity = capacity;
    this.baseNightlyRate = baseNightlyRate;
    this.extraGuestFee = extraGuestFee;
  }

  @Override
  public Long getId() {
    return id;
  }

  public Property getProperty() {
    return property;
  }

  public String getCode() {
    return code;
  }

  public String getName() {
    return name;
  }

  public int getCapacity() {
    return capacity;
  }

  public BigDecimal getBaseNightlyRate() {
    return baseNightlyRate;
  }

  public BigDecimal getExtraGuestFee() {
    return extraGuestFee;
  }

  /** Replaces the base rate and extra-guest fee for future quotes; stored quotes are unchanged. */
  public void reprice(BigDecimal baseNightlyRate, BigDecimal extraGuestFee) {
    this.baseNightlyRate = baseNightlyRate;
    this.extraGuestFee = extraGuestFee;
  }
}
