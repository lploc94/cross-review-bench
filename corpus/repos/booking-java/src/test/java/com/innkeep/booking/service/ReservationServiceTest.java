package com.innkeep.booking.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.innkeep.booking.domain.ConflictException;
import com.innkeep.booking.domain.Property;
import com.innkeep.booking.domain.Reservation;
import com.innkeep.booking.domain.ReservationStatus;
import com.innkeep.booking.domain.RoomType;
import com.innkeep.booking.domain.ValidationException;
import com.innkeep.booking.support.IntegrationTestBase;
import com.innkeep.booking.support.LogCapture;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.domain.PageRequest;

class ReservationServiceTest extends IntegrationTestBase {

  private static final LocalDate CHECK_IN = LocalDate.parse("2027-06-10");

  @Autowired private ReservationService reservations;
  @Autowired private BookingMaintenanceJob maintenance;

  private Property property;
  private RoomType room;
  private Reservation existing;

  @BeforeEach
  void setUp() {
    property = data.harbourHouse();
    room = data.roomType(property, "double", 2, "100.00");
    data.rooms(property, room, CHECK_IN, LocalDate.parse("2027-06-12"), 3);
    existing = data.book(property, room, CHECK_IN, LocalDate.parse("2027-06-12"), 1);
  }

  @Test
  void cancellingBeforeTheDeadlineRefundsEverythingAndReleasesTheRoom() {
    clock.set(Instant.parse("2027-06-01T10:00:00Z"));

    CancellationOutcome outcome = reservations.cancel(existing.getReference());

    assertThat(outcome.refund().amount().toPlainString()).isEqualTo("210.00");
    assertThat(outcome.reservation().getStatus()).isEqualTo(ReservationStatus.CANCELLED);
    assertThat(booked(room, CHECK_IN)).isZero();
    assertThat(payments.refundCount()).isEqualTo(1);
    assertThat(payments.movements().get(1).key()).isEqualTo("refund-" + existing.getId());
  }

  @Test
  void cancellingInsideTheWindowRefundsHalf() {
    clock.set(Instant.parse("2027-06-05T10:00:00Z"));

    CancellationOutcome outcome = reservations.cancel(existing.getReference());

    assertThat(outcome.refund().amount().toPlainString()).isEqualTo("105.00");
  }

  @Test
  void cancellingAfterCheckInRefundsNothing() {
    clock.set(Instant.parse("2027-06-10T14:00:00Z"));

    CancellationOutcome outcome = reservations.cancel(existing.getReference());

    assertThat(outcome.refund().isZero()).isTrue();
    assertThat(payments.refundCount()).isZero();
    assertThat(reservations.get(existing.getReference()).getStatus())
        .isEqualTo(ReservationStatus.CANCELLED);
  }

  @Test
  void cancellingTwiceIsAConflictAndRefundsOnce() {
    clock.set(Instant.parse("2027-06-01T10:00:00Z"));
    reservations.cancel(existing.getReference());

    assertThatThrownBy(() -> reservations.cancel(existing.getReference()))
        .isInstanceOf(ConflictException.class)
        .hasMessageContaining("CANCELLED");
    assertThat(payments.refundCount()).isEqualTo(1);
  }

  @Test
  void checkInFollowsTheDateInThePropertysOwnZone() {
    Property auckland = data.property("auckland-house", "Pacific/Auckland", 0, 0);
    RoomType suite = data.roomType(auckland, "suite", 2, "150.00");
    LocalDate arrival = LocalDate.parse("2027-06-02");
    data.rooms(auckland, suite, arrival, arrival.plusDays(1), 1);
    var reservation = data.book(auckland, suite, arrival, arrival.plusDays(1), 1);

    // 11:59Z is 23:59 on 1 June in Auckland (UTC+12 in June): too early
    clock.set(Instant.parse("2027-06-01T11:59:00Z"));
    assertThatThrownBy(() -> reservations.checkIn(reservation.getReference()))
        .isInstanceOf(ConflictException.class);

    // 12:00Z is midnight on 2 June in Auckland
    clock.set(Instant.parse("2027-06-01T12:00:00Z"));
    assertThat(reservations.checkIn(reservation.getReference()).getStatus())
        .isEqualTo(ReservationStatus.CHECKED_IN);
  }

  @Test
  void theLogAndThePaymentKeysNeverNameAReservationReference() throws Exception {
    Reservation other = data.book(property, room, CHECK_IN, LocalDate.parse("2027-06-12"), 1);
    String logged =
        LogCapture.during(
            ReservationService.class.getName(),
            () -> {
              reservations.cancel(existing.getReference());
              clock.set(Instant.parse("2027-06-10T14:00:00Z"));
              reservations.checkIn(other.getReference());
            });

    assertThat(logged)
        .doesNotContain(existing.getReference())
        .doesNotContain(other.getReference())
        .contains("\"reservationId\":" + existing.getId());
    assertThat(payments.movements()).noneMatch(m -> m.key().contains(existing.getReference()));
  }

  @Test
  void checkInBeforeTheCheckInDateIsRefused() {
    clock.set(Instant.parse("2027-06-09T10:00:00Z"));

    assertThatThrownBy(() -> reservations.checkIn(existing.getReference()))
        .isInstanceOf(ConflictException.class);
  }

  @Test
  void aDepartedStayIsCompletedEvenWhenEarlierCheckOutsInAnotherZoneHaveNotDeparted() {
    Property honolulu = data.property("island-stay", "Pacific/Honolulu", 10, 0);
    Property auckland = data.property("bay-stay", "Pacific/Auckland", 10, 0);
    RoomType islandRoom = data.roomType(honolulu, "double", 2, "100.00");
    RoomType bayRoom = data.roomType(auckland, "double", 2, "100.00");
    LocalDate from = LocalDate.parse("2027-05-30");
    LocalDate to = LocalDate.parse("2027-06-02");
    data.rooms(honolulu, islandRoom, from, to, 2);
    data.rooms(auckland, bayRoom, from, to, 1);
    // Two stays with the same check-out date that Honolulu has not yet reached, then one that
    // Auckland has. The batch size is 2, so the first batch holds only the lagging stays.
    List<Reservation> lagging =
        List.of(
            data.book(honolulu, islandRoom, from, to, 1),
            data.book(honolulu, islandRoom, from, to, 1));
    Reservation departed = data.book(auckland, bayRoom, from, to, 1);
    clock.set(Instant.parse("2027-05-31T10:00:00Z"));
    for (Reservation stay : lagging) {
      reservations.checkIn(stay.getReference());
    }
    reservations.checkIn(departed.getReference());

    // 09:00Z on 2 June: 23:00 on 1 June in Honolulu, 21:00 on 2 June in Auckland.
    clock.set(Instant.parse("2027-06-02T09:00:00Z"));

    assertThat(maintenance.completeDepartedStays()).isEqualTo(1);
    assertThat(reservations.get(departed.getReference()).getStatus())
        .isEqualTo(ReservationStatus.COMPLETED);
    for (Reservation stay : lagging) {
      assertThat(reservations.get(stay.getReference()).getStatus())
          .isEqualTo(ReservationStatus.CHECKED_IN);
    }
  }

  @Test
  void aCheckedInStayCompletesOnceItsCheckOutDayHasStartedInTheZone() {
    clock.set(Instant.parse("2027-06-10T14:00:00Z"));
    reservations.checkIn(existing.getReference());

    clock.set(Instant.parse("2027-06-11T20:00:00Z"));
    assertThat(maintenance.completeDepartedStays()).isZero();

    clock.set(Instant.parse("2027-06-12T00:00:00Z"));
    assertThat(maintenance.completeDepartedStays()).isEqualTo(1);
    assertThat(reservations.get(existing.getReference()).getStatus())
        .isEqualTo(ReservationStatus.COMPLETED);
  }

  @Test
  void searchFiltersByStatusAndNormalisesTheEmail() {
    var second = data.book(property, room, CHECK_IN, LocalDate.parse("2027-06-11"), 1);
    clock.set(Instant.parse("2027-06-01T10:00:00Z"));
    reservations.cancel(second.getReference());
    var page = PageRequest.of(0, 20);

    assertThat(reservations.search(null, null, null, null, null, null, page).getTotalElements())
        .isEqualTo(2);
    assertThat(
            reservations
                .search(
                    null,
                    ReservationStatus.CONFIRMED,
                    null,
                    null,
                    "  GUEST@EXAMPLE.COM ",
                    null,
                    page)
                .getTotalElements())
        .isEqualTo(1);
    assertThat(
            reservations
                .search(null, ReservationStatus.CANCELLED, null, null, null, null, page)
                .getContent())
        .extracting(Reservation::getReference)
        .containsExactly(second.getReference());
  }

  @Test
  void aSearchWithReversedDatesIsRefused() {
    assertThatThrownBy(
            () ->
                reservations.search(
                    null,
                    null,
                    LocalDate.parse("2027-06-12"),
                    LocalDate.parse("2027-06-01"),
                    null,
                    null,
                    PageRequest.of(0, 20)))
        .isInstanceOf(ValidationException.class);
  }
}
