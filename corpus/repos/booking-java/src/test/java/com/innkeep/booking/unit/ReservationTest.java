package com.innkeep.booking.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.innkeep.booking.domain.ConflictException;
import com.innkeep.booking.domain.DateRange;
import com.innkeep.booking.domain.Reservation;
import com.innkeep.booking.domain.ReservationStatus;
import com.innkeep.booking.support.Fixtures;
import java.time.Instant;
import java.time.LocalDate;
import org.junit.jupiter.api.Test;

class ReservationTest {

  private static final Instant NOW = Instant.parse("2027-06-01T10:00:00Z");

  private Reservation reservation() {
    var property = Fixtures.property("Europe/Lisbon", 0, 0);
    var room = Fixtures.roomType(property, 2, "100.00");
    var stay = new DateRange(LocalDate.parse("2027-06-10"), LocalDate.parse("2027-06-14"));
    return new Reservation("IK-TEST0001", Fixtures.hold(property, room, stay, NOW), NOW);
  }

  @Test
  void checkInStartsOnTheCheckInDateOfTheProperty() {
    var reservation = reservation();

    assertThatThrownBy(() -> reservation.checkIn(NOW, LocalDate.parse("2027-06-09")))
        .isInstanceOf(ConflictException.class);
    reservation.checkIn(NOW, LocalDate.parse("2027-06-10"));
    assertThat(reservation.getStatus()).isEqualTo(ReservationStatus.CHECKED_IN);
  }

  @Test
  void checkInIsRefusedOnTheCheckOutDate() {
    var reservation = reservation();

    assertThatThrownBy(() -> reservation.checkIn(NOW, LocalDate.parse("2027-06-14")))
        .isInstanceOf(ConflictException.class);
  }

  @Test
  void cancelIsOnlyAllowedOnce() {
    var reservation = reservation();
    reservation.cancel(NOW);

    assertThat(reservation.getStatus()).isEqualTo(ReservationStatus.CANCELLED);
    assertThatThrownBy(() -> reservation.cancel(NOW)).isInstanceOf(ConflictException.class);
  }

  @Test
  void aStayCompletesOnlyFromItsCheckOutDate() {
    var reservation = reservation();
    reservation.checkIn(NOW, LocalDate.parse("2027-06-10"));

    assertThat(reservation.completeIfDeparted(NOW, LocalDate.parse("2027-06-13"))).isFalse();
    assertThat(reservation.completeIfDeparted(NOW, LocalDate.parse("2027-06-14"))).isTrue();
    assertThat(reservation.getStatus()).isEqualTo(ReservationStatus.COMPLETED);
  }
}
