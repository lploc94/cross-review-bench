package com.innkeep.booking.service;

import static org.assertj.core.api.Assertions.assertThat;

import com.innkeep.booking.domain.Property;
import com.innkeep.booking.domain.Reservation;
import com.innkeep.booking.domain.RoomType;
import com.innkeep.booking.support.IntegrationTestBase;
import java.time.Instant;
import java.time.LocalDate;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

/** A cancellation refunds the policy's share of the price, but never more than was paid. */
class DepositCancellationRefundTest extends IntegrationTestBase {

  private static final LocalDate IN = LocalDate.parse("2027-06-07");
  private static final LocalDate OUT = LocalDate.parse("2027-06-09");
  // 7 days before check-in at 15:00 Lisbon is 2027-05-31T14:00Z
  private static final Instant FULL_WINDOW = Instant.parse("2027-05-20T09:00:00Z");
  private static final Instant PARTIAL_WINDOW = Instant.parse("2027-06-03T09:00:00Z");

  @Autowired private CatalogService catalog;
  @Autowired private ReservationService reservations;

  private Property property;
  private RoomType room;

  @BeforeEach
  void setUp() {
    property = data.harbourHouse();
    room = data.roomType(property, "double", 2, "100.00");
    data.rooms(property, room, IN, OUT, 2);
  }

  @Test
  void inTheFullRefundWindowTheDepositIsRefunded() {
    Reservation reservation = bookWithDeposit(30);
    clock.set(FULL_WINDOW);

    assertThat(quotedRefund(reservation)).isEqualTo("60.00");
    assertThat(cancel(reservation)).isEqualTo("60.00");
    assertThat(payments.movements().get(1).amount().amount().toPlainString()).isEqualTo("60.00");
  }

  @Test
  void inThePartialWindowAPolicyShareAboveTheDepositIsCappedAtTheDeposit() {
    Reservation reservation = bookWithDeposit(30);
    clock.set(PARTIAL_WINDOW);

    // 50 % of 200.00 would be 100.00, but only 60.00 was paid
    assertThat(quotedRefund(reservation)).isEqualTo("60.00");
    assertThat(cancel(reservation)).isEqualTo("60.00");
  }

  @Test
  void inThePartialWindowAPolicyShareBelowTheDepositIsTheShareOfThePrice() {
    Reservation reservation = bookWithDeposit(80);
    clock.set(PARTIAL_WINDOW);

    // 160.00 was paid; 50 % of the 200.00 price is due back
    assertThat(cancel(reservation)).isEqualTo("100.00");
  }

  @Test
  void withTheWholePricePaidThePolicyAppliesToThePrice() {
    Reservation reservation = data.book(property, room, IN, OUT, 1);
    clock.set(PARTIAL_WINDOW);

    assertThat(cancel(reservation)).isEqualTo("100.00");
  }

  private Reservation bookWithDeposit(int percent) {
    catalog.changePolicy(property.getCode(), new PolicyDraft(7, 50, 10, 7, 0, percent));
    return data.book(property, room, IN, OUT, 1);
  }

  private String quotedRefund(Reservation reservation) {
    return reservations
        .quoteCancellation(reservation.getReference(), null)
        .refund()
        .amount()
        .toPlainString();
  }

  private String cancel(Reservation reservation) {
    return reservations.cancel(reservation.getReference()).refund().amount().toPlainString();
  }
}
