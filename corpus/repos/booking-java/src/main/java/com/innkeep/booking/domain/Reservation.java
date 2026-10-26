package com.innkeep.booking.domain;

import jakarta.persistence.CollectionTable;
import jakarta.persistence.Column;
import jakarta.persistence.ElementCollection;
import jakarta.persistence.Embedded;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.FetchType;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.JoinColumn;
import jakarta.persistence.ManyToOne;
import jakarta.persistence.OrderColumn;
import jakarta.persistence.Table;
import jakarta.persistence.Version;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Currency;
import java.util.List;
import java.util.UUID;

/**
 * A confirmed booking. It copies the hold's price lines and total, so later rule changes do not
 * touch it. Status changes go through the methods below and are checked against the state.
 * {@code @Version} turns two concurrent writers into an optimistic-lock failure.
 */
@Entity
@Table(name = "reservation")
public class Reservation extends AbstractEntity<Long> {

  @Id
  @GeneratedValue(strategy = GenerationType.IDENTITY)
  private Long id;

  @Column(nullable = false, unique = true, length = 16)
  private String reference;

  @Column(name = "hold_id", nullable = false, unique = true)
  private UUID holdId;

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

  @Enumerated(EnumType.STRING)
  @Column(nullable = false, length = 16)
  private ReservationStatus status;

  @Embedded private GuestDetails guest;

  @Column(nullable = false, length = 3)
  private String currency;

  @Column(name = "total_amount", nullable = false, precision = 12, scale = 2)
  private BigDecimal totalAmount;

  @ElementCollection(fetch = FetchType.LAZY)
  @CollectionTable(
      name = "reservation_price_line",
      joinColumns = @JoinColumn(name = "reservation_id"))
  @OrderColumn(name = "position")
  private List<PriceLine> priceLines = new ArrayList<>();

  @Column(name = "created_at", nullable = false)
  private Instant createdAt;

  @Column(name = "updated_at", nullable = false)
  private Instant updatedAt;

  @Column(name = "cancelled_at")
  private Instant cancelledAt;

  @Version private Long version;

  protected Reservation() {}

  public Reservation(String reference, Hold hold, Instant now) {
    this.reference = reference;
    this.holdId = hold.getId();
    this.property = hold.getProperty();
    this.roomType = hold.getRoomType();
    this.checkIn = hold.getStay().checkIn();
    this.checkOut = hold.getStay().checkOut();
    this.rooms = hold.getRooms();
    this.guests = hold.getGuests();
    this.status = ReservationStatus.CONFIRMED;
    this.guest = hold.getGuest();
    this.currency = hold.getTotal().currency().getCurrencyCode();
    this.totalAmount = hold.getTotal().amount();
    this.priceLines.addAll(hold.getPriceLines());
    this.createdAt = now;
    this.updatedAt = now;
  }

  @Override
  public Long getId() {
    return id;
  }

  public String getReference() {
    return reference;
  }

  public UUID getHoldId() {
    return holdId;
  }

  public Property getProperty() {
    return property;
  }

  public RoomType getRoomType() {
    return roomType;
  }

  public LocalDate getCheckIn() {
    return checkIn;
  }

  public LocalDate getCheckOut() {
    return checkOut;
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

  public ReservationStatus getStatus() {
    return status;
  }

  public GuestDetails getGuest() {
    return guest;
  }

  public Money getTotal() {
    return Money.of(totalAmount, Currency.getInstance(currency));
  }

  public List<PriceLine> getPriceLines() {
    return List.copyOf(priceLines);
  }

  public Instant getCreatedAt() {
    return createdAt;
  }

  public Instant getUpdatedAt() {
    return updatedAt;
  }

  public Instant getCancelledAt() {
    return cancelledAt;
  }

  public void cancel(Instant now) {
    requireStatus(ReservationStatus.CONFIRMED, "cancelled");
    this.status = ReservationStatus.CANCELLED;
    this.cancelledAt = now;
    this.updatedAt = now;
  }

  /** Checks the guest in on or after the property-local check-in date and before check-out. */
  public void checkIn(Instant now, LocalDate propertyToday) {
    requireStatus(ReservationStatus.CONFIRMED, "checked in");
    if (propertyToday.isBefore(checkIn) || !propertyToday.isBefore(checkOut)) {
      throw new ConflictException(
          "reservation " + reference + " can be checked in from " + checkIn + " until " + checkOut);
    }
    this.status = ReservationStatus.CHECKED_IN;
    this.updatedAt = now;
  }

  /** Marks a checked-in stay as completed once its check-out date has been reached. */
  public boolean completeIfDeparted(Instant now, LocalDate propertyToday) {
    if (status != ReservationStatus.CHECKED_IN || propertyToday.isBefore(checkOut)) {
      return false;
    }
    this.status = ReservationStatus.COMPLETED;
    this.updatedAt = now;
    return true;
  }

  private void requireStatus(ReservationStatus expected, String action) {
    if (status != expected) {
      throw new ConflictException(
          "reservation " + reference + " is " + status + " and cannot be " + action);
    }
  }
}
