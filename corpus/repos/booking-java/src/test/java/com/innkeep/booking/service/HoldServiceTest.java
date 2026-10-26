package com.innkeep.booking.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.innkeep.booking.domain.ConflictException;
import com.innkeep.booking.domain.DateRange;
import com.innkeep.booking.domain.GuestDetails;
import com.innkeep.booking.domain.Hold;
import com.innkeep.booking.domain.HoldExpiredException;
import com.innkeep.booking.domain.HoldStatus;
import com.innkeep.booking.domain.InsufficientAvailabilityException;
import com.innkeep.booking.domain.Property;
import com.innkeep.booking.domain.Reservation;
import com.innkeep.booking.domain.RoomType;
import com.innkeep.booking.domain.ValidationException;
import com.innkeep.booking.support.IntegrationTestBase;
import com.innkeep.booking.support.TestConfig;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

class HoldServiceTest extends IntegrationTestBase {

  private static final LocalDate JUNE_1 = LocalDate.parse("2027-06-01");
  private static final LocalDate JUNE_2 = LocalDate.parse("2027-06-02");
  private static final LocalDate JUNE_3 = LocalDate.parse("2027-06-03");
  private static final LocalDate JUNE_4 = LocalDate.parse("2027-06-04");
  private static final LocalDate JUNE_5 = LocalDate.parse("2027-06-05");
  private static final LocalDate MAY_1 = LocalDate.parse("2027-05-01");
  private static final LocalDate MAY_2 = LocalDate.parse("2027-05-02");
  private static final LocalDate MAY_3 = LocalDate.parse("2027-05-03");

  @Autowired private HoldService holds;
  @Autowired private BookingMaintenanceJob maintenance;

  private Property property;
  private RoomType room;

  @BeforeEach
  void setUp() {
    property = data.harbourHouse();
    room = data.roomType(property, "double", 2, "100.00");
    data.rooms(property, room, JUNE_1, JUNE_5, 2);
  }

  @Test
  void holdingRoomsMovesThemIntoHeldForEveryNight() {
    data.hold(property, room, JUNE_1, JUNE_3, 1);

    assertThat(held(room, JUNE_1)).isEqualTo(1);
    assertThat(held(room, JUNE_2)).isEqualTo(1);
    assertThat(held(room, JUNE_3)).isZero();
  }

  @Test
  void aStayQuotedAtZeroIsConfirmedWithoutAChargeOrALedgerEntry() {
    RoomType comp = data.roomType(property, "comp", 2, "0.00");
    data.rooms(property, comp, JUNE_1, JUNE_3, 1);
    Hold hold = data.hold(property, comp, JUNE_1, JUNE_3, 1);

    Reservation reservation = holds.confirm(hold.getId());

    assertThat(reservation.getTotal().isZero()).isTrue();
    assertThat(payments.movements()).isEmpty();
    assertThat(jdbc.queryForObject("select count(*) from ledger_entry", Integer.class)).isZero();
    assertThat(booked(comp, JUNE_1)).isEqualTo(1);
    assertThat(booked(comp, JUNE_2)).isEqualTo(1);
  }

  @Test
  void aStayShortOnOneNightTakesNothingOnAnyNight() {
    data.hold(property, room, JUNE_4, JUNE_5, 2);

    assertThatThrownBy(() -> data.hold(property, room, JUNE_1, JUNE_5, 1))
        .isInstanceOf(InsufficientAvailabilityException.class)
        .hasMessageContaining("2027-06-04");
    assertThat(held(room, JUNE_1)).isZero();
    assertThat(held(room, JUNE_2)).isZero();
    assertThat(held(room, JUNE_3)).isZero();
    assertThat(held(room, JUNE_4)).isEqualTo(2);
  }

  @Test
  void aHoldAtExactlyItsTimeLimitCannotBeConfirmed() {
    Hold hold = data.hold(property, room, JUNE_1, JUNE_2, 1);
    clock.set(TestConfig.START.plus(Duration.ofMinutes(15)));

    assertThatThrownBy(() -> holds.confirm(hold.getId())).isInstanceOf(HoldExpiredException.class);
    assertThat(holds.get(hold.getId()).getStatus()).isEqualTo(HoldStatus.ACTIVE);
  }

  @Test
  void aHoldOneNanosecondBeforeItsTimeLimitCanBeConfirmed() {
    Hold hold = data.hold(property, room, JUNE_1, JUNE_2, 1);
    clock.set(TestConfig.START.plus(Duration.ofMinutes(15)).minusNanos(1));

    Reservation reservation = holds.confirm(hold.getId());

    assertThat(reservation.getStatus().name()).isEqualTo("CONFIRMED");
    assertThat(held(room, JUNE_1)).isZero();
    assertThat(booked(room, JUNE_1)).isEqualTo(1);
  }

  @Test
  void confirmingMovesHeldToBookedAndChargesOnce() {
    Hold hold = data.hold(property, room, JUNE_1, JUNE_2, 1);

    holds.confirm(hold.getId());

    assertThat(booked(room, JUNE_1)).isEqualTo(1);
    assertThat(payments.movements()).hasSize(1);
    assertThat(payments.movements().get(0).key()).isEqualTo("charge-" + hold.getId());
    assertThat(payments.movements().get(0).amount().amount().toPlainString()).isEqualTo("100.00");
  }

  @Test
  void aConfirmedHoldCannotBeConfirmedAgain() {
    Hold hold = data.hold(property, room, JUNE_1, JUNE_2, 1);
    holds.confirm(hold.getId());

    assertThatThrownBy(() -> holds.confirm(hold.getId())).isInstanceOf(ConflictException.class);
    assertThat(payments.movements()).hasSize(1);
  }

  @Test
  void aStayCannotBeHeldForANightThatHasAlreadyPassedAtTheProperty() {
    data.rooms(property, room, MAY_1, MAY_3, 1);
    // 23:30Z on 1 May is 00:30 on 2 May in Lisbon, so 1 May is over there while it is still today
    // in UTC.
    clock.set(Instant.parse("2027-05-01T23:30:00Z"));

    assertThatThrownBy(() -> data.hold(property, room, MAY_1, MAY_2, 1))
        .isInstanceOf(ValidationException.class);
    assertThat(held(room, MAY_1)).isZero();
    assertThat(data.hold(property, room, MAY_2, MAY_3, 1).getStatus()).isEqualTo(HoldStatus.ACTIVE);
  }

  @Test
  void aHoldCannotBeConfirmedOnceItsCheckInDayHasPassedAtTheProperty() {
    // 23:50 on 1 June in Lisbon: the hold is made for 1 June, which is still today.
    clock.set(Instant.parse("2027-06-01T22:50:00Z"));
    Hold hold = data.hold(property, room, JUNE_1, JUNE_2, 1);

    // 00:02 on 2 June in Lisbon, inside the 15-minute time limit: the stay has begun.
    clock.set(Instant.parse("2027-06-01T23:02:00Z"));

    assertThatThrownBy(() -> holds.confirm(hold.getId())).isInstanceOf(HoldExpiredException.class);
    assertThat(holds.get(hold.getId()).getStatus()).isEqualTo(HoldStatus.ACTIVE);
    assertThat(payments.movements()).isEmpty();
  }

  @Test
  void releasingGivesTheRoomsBackOnce() {
    Hold hold = data.hold(property, room, JUNE_1, JUNE_2, 1);

    holds.release(hold.getId());

    assertThat(held(room, JUNE_1)).isZero();
    assertThat(holds.get(hold.getId()).getStatus()).isEqualTo(HoldStatus.RELEASED);
    assertThatThrownBy(() -> holds.release(hold.getId())).isInstanceOf(ConflictException.class);
  }

  @Test
  void cleanupExpiresOnlyPastHoldsAndDrainsBatches() {
    data.rooms(property, room, JUNE_1, JUNE_2, 5);
    for (int i = 0; i < 3; i++) {
      data.hold(property, room, JUNE_1, JUNE_2, 1);
    }
    Hold confirmed = data.hold(property, room, JUNE_1, JUNE_2, 1);
    holds.confirm(confirmed.getId());
    clock.set(TestConfig.START.plus(Duration.ofMinutes(16)));
    Hold fresh = data.hold(property, room, JUNE_1, JUNE_2, 1);

    int expired = maintenance.releaseExpiredHolds();

    assertThat(expired).isEqualTo(3);
    assertThat(holds.get(fresh.getId()).getStatus()).isEqualTo(HoldStatus.ACTIVE);
    assertThat(holds.get(confirmed.getId()).getStatus()).isEqualTo(HoldStatus.CONFIRMED);
    assertThat(held(room, JUNE_1)).isEqualTo(1);
    assertThat(booked(room, JUNE_1)).isEqualTo(1);
  }

  @Test
  void theHoldKeepsItsGuestDetailsAndQuote() {
    Hold hold = data.hold(property, room, JUNE_1, JUNE_3, 1);
    GuestDetails guest = hold.getGuest();

    assertThat(guest.getEmail()).isEqualTo("guest@example.com");
    assertThat(hold.getStay()).isEqualTo(new DateRange(JUNE_1, JUNE_3));
    assertThat(hold.getTotal().amount().toPlainString()).isEqualTo("200.00");
  }
}
