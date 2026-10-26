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
import java.time.LocalDate;

/**
 * A nightly rate that replaces the base rate for the nights from start to end (both inclusive).
 * When several rates cover a night the lowest priority number wins.
 */
@Entity
@Table(name = "seasonal_rate")
public class SeasonalRate extends AbstractEntity<Long> {

  @Id
  @GeneratedValue(strategy = GenerationType.IDENTITY)
  private Long id;

  @ManyToOne(fetch = FetchType.LAZY, optional = false)
  @JoinColumn(name = "room_type_id", nullable = false)
  private RoomType roomType;

  @Column(name = "start_date", nullable = false)
  private LocalDate startDate;

  @Column(name = "end_date", nullable = false)
  private LocalDate endDate;

  @Column(name = "nightly_rate", nullable = false, precision = 12, scale = 2)
  private BigDecimal nightlyRate;

  @Column(nullable = false)
  private int priority;

  protected SeasonalRate() {}

  public SeasonalRate(
      RoomType roomType,
      LocalDate startDate,
      LocalDate endDate,
      BigDecimal nightlyRate,
      int priority) {
    this.roomType = roomType;
    this.startDate = startDate;
    this.endDate = endDate;
    this.nightlyRate = nightlyRate;
    this.priority = priority;
  }

  @Override
  public Long getId() {
    return id;
  }

  public RoomType getRoomType() {
    return roomType;
  }

  public LocalDate getStartDate() {
    return startDate;
  }

  public LocalDate getEndDate() {
    return endDate;
  }

  public BigDecimal getNightlyRate() {
    return nightlyRate;
  }

  public int getPriority() {
    return priority;
  }

  public boolean covers(LocalDate night) {
    return !night.isBefore(startDate) && !night.isAfter(endDate);
  }

  /** Replaces the dates, nightly rate and priority; the catalog service checks the overlap rule. */
  public void change(LocalDate startDate, LocalDate endDate, BigDecimal nightlyRate, int priority) {
    this.startDate = startDate;
    this.endDate = endDate;
    this.nightlyRate = nightlyRate;
    this.priority = priority;
  }
}
