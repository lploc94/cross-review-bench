package com.innkeep.booking.service;

import static org.assertj.core.api.Assertions.assertThat;

import com.innkeep.booking.domain.DateRange;
import com.innkeep.booking.domain.GuestDetails;
import com.innkeep.booking.domain.Property;
import com.innkeep.booking.domain.Reservation;
import com.innkeep.booking.domain.ReservationStatus;
import com.innkeep.booking.domain.RoomType;
import com.innkeep.booking.support.IntegrationTestBase;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

class NoShowSettlementCheckTest extends IntegrationTestBase {

  @Autowired private ReservationService reservations;
  @Autowired private HoldService holds;
  @Autowired private BookingMaintenanceJob maintenance;

  private Reservation book(
      Property property, RoomType type, String in, String out, int rooms, int guests) {
    var hold =
        holds.create(
            property.getCode(),
            type.getCode(),
            new DateRange(LocalDate.parse(in), LocalDate.parse(out)),
            rooms,
            guests,
            new GuestDetails("Ilsa Morrow", "ilsa@example.com", null));
    return holds.confirm(hold.getId());
  }

  private BigDecimal ledgerSum(Reservation reservation, String kind) {
    return jdbc.queryForObject(
        "select coalesce(sum(amount), 0) from ledger_entry where reservation_id = ? and kind = ?",
        BigDecimal.class,
        reservation.getId(),
        kind);
  }

  @Test
  void theFeeIsTheFirstNightsLinesAndTheRestIsRefunded() {
    // weekend surcharge 10 %, length-of-stay discount 10 % from 7 nights
    Property property = data.property("bay-house", "Europe/Lisbon", 10, 10);
    RoomType room = data.roomType(property, "twin", 2, "80.00");
    LocalDate in = LocalDate.parse("2027-06-11"); // a Friday
    data.rooms(property, room, in, in.plusDays(7), 3);
    // 2 rooms, 5 guests: one extra guest at 15.00 a night
    Reservation reservation = book(property, room, "2027-06-11", "2027-06-18", 2, 5);
    // rooms 176 + 176 + 5 x 160 = 1152.00; discount -115.20; extra guests 7 x 15 = 105.00
    assertThat(reservation.getTotal().amount()).isEqualByComparingTo("1141.80");

    clock.set(Instant.parse("2027-06-12T10:00:00Z")); // 11:00 in Lisbon the day after arrival
    NoShowOutcome outcome = reservations.markNoShow(reservation.getReference());

    assertThat(outcome.fee().amount()).isEqualByComparingTo("191.00");
    assertThat(outcome.refund().amount()).isEqualByComparingTo("950.80");
    assertThat(ledgerSum(reservation, "CHARGE")).isEqualByComparingTo("1141.80");
    assertThat(ledgerSum(reservation, "REFUND")).isEqualByComparingTo("950.80");
    assertThat(payments.movements())
        .filteredOn(m -> m.kind().equals("refund"))
        .singleElement()
        .satisfies(m -> assertThat(m.key()).isEqualTo("no-show-" + reservation.getId()));

    assertThat(booked(room, in)).isEqualTo(2);
    assertThat(held(room, in)).isZero();
    for (int i = 1; i < 7; i++) {
      assertThat(booked(room, in.plusDays(i))).isZero();
      assertThat(held(room, in.plusDays(i))).isZero();
    }
    // the freed nights can be sold again
    data.hold(property, room, in.plusDays(1), in.plusDays(7), 3);
  }

  @Test
  void theFeeNeverExceedsTheTotal() {
    // a 100 % length-of-stay discount leaves only the extra-guest fees
    Property property = data.property("cove-house", "Europe/Lisbon", 10, 100);
    RoomType room = data.roomType(property, "twin", 2, "200.00");
    LocalDate in = LocalDate.parse("2027-06-11");
    data.rooms(property, room, in, in.plusDays(7), 1);
    Reservation reservation = book(property, room, "2027-06-11", "2027-06-18", 1, 3);
    // the first night alone is 220.00 + 15.00
    assertThat(reservation.getTotal().amount()).isEqualByComparingTo("105.00");

    clock.set(Instant.parse("2027-06-12T10:00:00Z"));
    NoShowOutcome outcome = reservations.markNoShow(reservation.getReference());

    assertThat(outcome.fee().amount()).isEqualByComparingTo("105.00");
    assertThat(outcome.refund().isZero()).isTrue();
    assertThat(payments.refundCount()).isZero();
    assertThat(ledgerSum(reservation, "REFUND")).isEqualByComparingTo("0");
  }

  @Test
  void aOneNightNoShowKeepsEverythingAndKeepsTheNightBooked() {
    Property property = data.harbourHouse();
    RoomType room = data.roomType(property, "double", 2, "100.00");
    LocalDate in = LocalDate.parse("2027-06-10");
    data.rooms(property, room, in, in.plusDays(1), 1);
    Reservation reservation = data.book(property, room, in, in.plusDays(1), 1);

    clock.set(Instant.parse("2027-06-11T10:00:00Z"));
    NoShowOutcome outcome = reservations.markNoShow(reservation.getReference());

    assertThat(outcome.fee().amount()).isEqualByComparingTo("100.00");
    assertThat(outcome.refund().isZero()).isTrue();
    assertThat(payments.refundCount()).isZero();
    assertThat(booked(room, in)).isEqualTo(1);
  }

  @Test
  void theJobFollowsThePropertyZoneAndIsIdempotent() {
    Property auckland = data.property("kauri-lodge", "Pacific/Auckland", 0, 0);
    RoomType room = data.roomType(auckland, "suite", 2, "150.00");
    LocalDate in = LocalDate.parse("2027-06-10");
    data.rooms(auckland, room, in, in.plusDays(3), 5);
    Reservation first = data.book(auckland, room, in, in.plusDays(3), 1);
    Reservation second = data.book(auckland, room, in, in.plusDays(2), 1);
    Reservation third = data.book(auckland, room, in, in.plusDays(3), 2);
    Reservation tomorrow = data.book(auckland, room, in.plusDays(1), in.plusDays(3), 1);

    // 11:00 on 11 June in Auckland (UTC+12) is 23:00Z on 10 June
    clock.set(Instant.parse("2027-06-10T22:59:59Z"));
    assertThat(maintenance.markNoShows()).isZero();

    clock.set(Instant.parse("2027-06-10T23:00:00Z"));
    assertThat(maintenance.markNoShows()).isEqualTo(3);
    assertThat(maintenance.markNoShows()).isZero();
    assertThat(maintenance.run().noShows()).isZero();

    for (Reservation r : new Reservation[] {first, second, third}) {
      assertThat(reservations.get(r.getReference()).getStatus())
          .isEqualTo(ReservationStatus.NO_SHOW);
    }
    assertThat(reservations.get(tomorrow.getReference()).getStatus())
        .isEqualTo(ReservationStatus.CONFIRMED);
    assertThat(payments.refundCount()).isEqualTo(3);
    assertThat(
            jdbc.queryForObject(
                "select count(*) from ledger_entry where kind = 'REFUND'", Integer.class))
        .isEqualTo(3);
    // night 1 keeps the four booked rooms; night 2 keeps only tomorrow's arrival; night 3 likewise
    assertThat(booked(room, in)).isEqualTo(4);
    assertThat(booked(room, in.plusDays(1))).isEqualTo(1);
    assertThat(booked(room, in.plusDays(2))).isEqualTo(1);
  }
}
