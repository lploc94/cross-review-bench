package com.innkeep.booking.domain;

import jakarta.persistence.CollectionTable;
import jakarta.persistence.Column;
import jakarta.persistence.ElementCollection;
import jakarta.persistence.Embedded;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.FetchType;
import jakarta.persistence.Id;
import jakarta.persistence.JoinColumn;
import jakarta.persistence.ManyToOne;
import jakarta.persistence.OrderColumn;
import jakarta.persistence.Table;
import jakarta.persistence.Version;
import java.math.BigDecimal;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Currency;
import java.util.List;
import java.util.UUID;

/**
 * Rooms held for a guest while they pay. The rooms are counted as held in inventory until the hold
 * is confirmed (they become booked), released, or expires. The hold keeps the quote it was made
 * with, so the reservation can copy it.
 */
@Entity
@Table(name = "hold")
public class Hold extends AbstractEntity<UUID> {

  @Id private UUID id;

  @ManyToOne(fetch = FetchType.LAZY, optional = false)
  @JoinColumn(name = "property_id", nullable = false)
  private Property property;

  @ManyToOne(fetch = FetchType.LAZY, optional = false)
  @JoinColumn(name = "room_type_id", nullable = false)
  private RoomType roomType;

  @Column(name = "check_in", nullable = false)
  private LocalDate checkIn;

  @Column(name = "check_out", nullable = false)
  private LocalDate checkOut;

  @Column(nullable = false)
  private int rooms;

  @Column(nullable = false)
  private int guests;

  @Embedded private GuestDetails guest;

  @Enumerated(EnumType.STRING)
  @Column(nullable = false, length = 16)
  private HoldStatus status;

  @Column(nullable = false, length = 3)
  private String currency;

  @Column(name = "total_amount", nullable = false, precision = 12, scale = 2)
  private BigDecimal totalAmount;

  @Column(name = "expires_at", nullable = false)
  private Instant expiresAt;

  @Column(name = "created_at", nullable = false)
  private Instant createdAt;

  @Version private Long version;

  @ElementCollection(fetch = FetchType.LAZY)
  @CollectionTable(name = "hold_price_line", joinColumns = @JoinColumn(name = "hold_id"))
  @OrderColumn(name = "position")
  private List<PriceLine> priceLines = new ArrayList<>();

  protected Hold() {}

  public Hold(
      Property property,
      RoomType roomType,
      DateRange stay,
      int rooms,
      int guests,
      GuestDetails guest,
      Quote quote,
      Instant createdAt,
      Duration ttl) {
    this.id = UUID.randomUUID();
    this.property = property;
    this.roomType = roomType;
    this.checkIn = stay.checkIn();
    this.checkOut = stay.checkOut();
    this.rooms = rooms;
    this.guests = guests;
    this.guest = guest;
    this.status = HoldStatus.ACTIVE;
    this.currency = quote.total().currency().getCurrencyCode();
    this.totalAmount = quote.total().amount();
    this.expiresAt = createdAt.plus(ttl);
    this.createdAt = createdAt;
    this.priceLines.addAll(quote.lines());
  }

  @Override
  public UUID getId() {
    return id;
  }

  public Property getProperty() {
    return property;
  }

  public RoomType getRoomType() {
    return roomType;
  }

  public DateRange getStay() {
    return new DateRange(checkIn, checkOut);
  }

  public int getRooms() {
    return rooms;
  }

  public int getGuests() {
    return guests;
  }

  public GuestDetails getGuest() {
    return guest;
  }

  public HoldStatus getStatus() {
    return status;
  }

  public Money getTotal() {
    return Money.of(totalAmount, Currency.getInstance(currency));
  }

  public Instant getExpiresAt() {
    return expiresAt;
  }

  public Instant getCreatedAt() {
    return createdAt;
  }

  public List<PriceLine> getPriceLines() {
    return List.copyOf(priceLines);
  }

  /** A hold is usable while it is active and its time limit has not passed. */
  public boolean isExpiredAt(Instant now) {
    return !now.isBefore(expiresAt);
  }

  /** Throws unless the hold can still be confirmed at {@code now}. */
  public void requireUsable(Instant now) {
    switch (status) {
      case CONFIRMED -> throw new ConflictException("hold " + id + " is already confirmed");
      case RELEASED -> throw new ConflictException("hold " + id + " was released");
      case EXPIRED -> throw new HoldExpiredException(id.toString());
      case ACTIVE -> {
        if (isExpiredAt(now)) {
          throw new HoldExpiredException(id.toString());
        }
      }
    }
  }

  public void markConfirmed() {
    transition(HoldStatus.CONFIRMED);
  }

  public void markReleased() {
    transition(HoldStatus.RELEASED);
  }

  public void markExpired() {
    transition(HoldStatus.EXPIRED);
  }

  private void transition(HoldStatus next) {
    if (status != HoldStatus.ACTIVE) {
      throw new ConflictException("hold " + id + " is " + status + ", cannot become " + next);
    }
    this.status = next;
  }
}
