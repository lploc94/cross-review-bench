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
import jakarta.persistence.Version;
import java.time.LocalDate;
import org.hibernate.annotations.DynamicUpdate;

/**
 * Rooms of one type for one night. Holds and bookings change {@code held} and {@code booked} with
 * conditional bulk updates in {@code InventoryRepository}; the entity is used by the admin path to
 * set the total. {@code @DynamicUpdate} keeps that path from rewriting the counters it did not
 * read, and the version makes a stale write fail instead of overwriting a concurrent booking.
 */
@Entity
@Table(name = "inventory")
@DynamicUpdate
public class Inventory extends AbstractEntity<Long> {

  @Id
  @GeneratedValue(strategy = GenerationType.IDENTITY)
  private Long id;

  @ManyToOne(fetch = FetchType.LAZY, optional = false)
  @JoinColumn(name = "room_type_id", nullable = false)
  private RoomType roomType;

  @Column(nullable = false)
  private LocalDate night;

  @Column(nullable = false)
  private int total;

  @Column(nullable = false)
  private int held;

  @Column(nullable = false)
  private int booked;

  @Version private Long version;

  protected Inventory() {}

  public Inventory(RoomType roomType, LocalDate night, int total) {
    this.roomType = roomType;
    this.night = night;
    setTotal(total);
  }

  @Override
  public Long getId() {
    return id;
  }

  public RoomType getRoomType() {
    return roomType;
  }

  public LocalDate getNight() {
    return night;
  }

  public int getTotal() {
    return total;
  }

  public int getHeld() {
    return held;
  }

  public int getBooked() {
    return booked;
  }

  public int available() {
    return total - held - booked;
  }

  /** Sets the sellable total. It may not drop below the rooms already held or booked. */
  public void setTotal(int newTotal) {
    if (newTotal < 0) {
      throw new ValidationException("inventory total cannot be negative");
    }
    if (newTotal < held + booked) {
      throw new ConflictException(
          "inventory for " + night + " cannot go below " + (held + booked) + " rooms in use");
    }
    this.total = newTotal;
  }
}
