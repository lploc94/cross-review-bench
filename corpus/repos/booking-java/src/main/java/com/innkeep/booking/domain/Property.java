package com.innkeep.booking.domain;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.time.LocalTime;
import java.time.ZoneId;
import java.util.Currency;

/** A guest house. Its time zone decides what "today" and "before check-in" mean for it. */
@Entity
@Table(name = "property")
public class Property extends AbstractEntity<Long> {

  @Id
  @GeneratedValue(strategy = GenerationType.IDENTITY)
  private Long id;

  @Column(nullable = false, unique = true, length = 40)
  private String code;

  @Column(nullable = false, length = 120)
  private String name;

  @Column(name = "time_zone", nullable = false, length = 64)
  private String timeZone;

  @Column(name = "check_in_time", nullable = false)
  private LocalTime checkInTime;

  @Column(name = "check_out_time", nullable = false)
  private LocalTime checkOutTime;

  @Column(nullable = false, length = 3)
  private String currency;

  @Column(name = "full_refund_days", nullable = false)
  private int fullRefundDays;

  @Column(name = "partial_refund_percent", nullable = false)
  private int partialRefundPercent;

  @Column(name = "weekend_surcharge_percent", nullable = false)
  private int weekendSurchargePercent;

  @Column(name = "los_min_nights", nullable = false)
  private int losMinNights;

  @Column(name = "los_discount_percent", nullable = false)
  private int losDiscountPercent;

  protected Property() {}

  public Property(
      String code,
      String name,
      ZoneId zone,
      LocalTime checkInTime,
      LocalTime checkOutTime,
      Currency currency,
      int fullRefundDays,
      int partialRefundPercent,
      int weekendSurchargePercent,
      int losMinNights,
      int losDiscountPercent) {
    this.code = code;
    this.name = name;
    this.timeZone = zone.getId();
    this.checkInTime = checkInTime;
    this.checkOutTime = checkOutTime;
    this.currency = currency.getCurrencyCode();
    this.fullRefundDays = fullRefundDays;
    this.partialRefundPercent = partialRefundPercent;
    this.weekendSurchargePercent = weekendSurchargePercent;
    this.losMinNights = losMinNights;
    this.losDiscountPercent = losDiscountPercent;
  }

  @Override
  public Long getId() {
    return id;
  }

  public String getCode() {
    return code;
  }

  public String getName() {
    return name;
  }

  public ZoneId zone() {
    return ZoneId.of(timeZone);
  }

  public LocalTime getCheckInTime() {
    return checkInTime;
  }

  public LocalTime getCheckOutTime() {
    return checkOutTime;
  }

  public Currency currency() {
    return Currency.getInstance(currency);
  }

  public int getFullRefundDays() {
    return fullRefundDays;
  }

  public int getPartialRefundPercent() {
    return partialRefundPercent;
  }

  public int getWeekendSurchargePercent() {
    return weekendSurchargePercent;
  }

  public int getLosMinNights() {
    return losMinNights;
  }

  public int getLosDiscountPercent() {
    return losDiscountPercent;
  }

  /**
   * Replaces the refund and pricing rules. Cancellations and quotes made after the change use the
   * new rules; a booked reservation keeps the price lines it was quoted with.
   */
  public void changePolicy(
      int fullRefundDays,
      int partialRefundPercent,
      int weekendSurchargePercent,
      int losMinNights,
      int losDiscountPercent) {
    this.fullRefundDays = fullRefundDays;
    this.partialRefundPercent = partialRefundPercent;
    this.weekendSurchargePercent = weekendSurchargePercent;
    this.losMinNights = losMinNights;
    this.losDiscountPercent = losDiscountPercent;
  }

  /** Replaces the name, time zone and check-in and check-out times of the property. */
  public void changeDetails(
      String name, ZoneId zone, LocalTime checkInTime, LocalTime checkOutTime) {
    this.name = name;
    this.timeZone = zone.getId();
    this.checkInTime = checkInTime;
    this.checkOutTime = checkOutTime;
  }
}
