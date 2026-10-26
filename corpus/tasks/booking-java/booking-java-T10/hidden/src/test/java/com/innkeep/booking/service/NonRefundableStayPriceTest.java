package com.innkeep.booking.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.innkeep.booking.domain.DateRange;
import com.innkeep.booking.domain.GuestDetails;
import com.innkeep.booking.domain.PriceKind;
import com.innkeep.booking.domain.PriceLine;
import com.innkeep.booking.domain.Property;
import com.innkeep.booking.domain.Quote;
import com.innkeep.booking.domain.RatePlan;
import com.innkeep.booking.domain.Reservation;
import com.innkeep.booking.domain.RoomType;
import com.innkeep.booking.support.IntegrationTestBase;
import com.innkeep.booking.support.TestData;
import java.time.LocalDate;
import java.util.List;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.MediaType;

/**
 * A non-refundable week with a weekend, a length-of-stay discount and an extra guest. Room nights:
 * five at 100.00 and Friday and Saturday at 110.00 (720.00); length-of-stay discount 5 % (−36.00);
 * one extra guest at 15.00 for seven nights (105.00). The rate plan takes 10 % of all of it: 10 %
 * of 789.00 is 78.90, so the stay costs 710.10.
 */
class NonRefundableStayPriceTest extends IntegrationTestBase {

  private static final DateRange WEEK =
      new DateRange(LocalDate.parse("2027-06-07"), LocalDate.parse("2027-06-14"));

  @Autowired private PricingService pricing;
  @Autowired private HoldService holds;
  @Autowired private ReservationService reservations;
  @Autowired private CatalogService catalog;

  private RoomType room;

  @BeforeEach
  void setUp() throws Exception {
    Property property = data.property("quay-house", TestData.LISBON.getId(), 10, 5);
    mvc.perform(
            post("/api/v1/admin/properties/quay-house/room-types")
                .header("Authorization", ADMIN_AUTH)
                .contentType(MediaType.APPLICATION_JSON)
                .content(
                    "{\"code\":\"double\",\"name\":\"Double\",\"capacity\":2,"
                        + "\"baseNightlyRate\":100.00,\"extraGuestFee\":15.00,"
                        + "\"nonRefundableDiscountPercent\":10}"))
        .andExpect(status().isCreated());
    room = catalog.roomType("quay-house", "double");
    data.rooms(property, room, WEEK.checkIn(), WEEK.checkOut(), 2);
  }

  @Test
  void theDiscountIsTakenFromEveryOtherLine() {
    Quote quote = pricing.quote("quay-house", "double", WEEK, 1, 3, RatePlan.NON_REFUNDABLE);

    List<PriceLine> lines = quote.lines();
    PriceLine last = lines.get(lines.size() - 1);
    assertThat(lines).filteredOn(l -> l.getKind() == PriceKind.RATE_PLAN_DISCOUNT).hasSize(1);
    assertThat(last.getKind()).isEqualTo(PriceKind.RATE_PLAN_DISCOUNT);
    assertThat(last.getAmount()).isEqualByComparingTo("-78.90");
    assertThat(quote.total().amount()).isEqualByComparingTo("710.10");
  }

  @Test
  void aNonRefundableWeekIsChargedTheDocumentedTotalAndRefundsNothing() {
    var guest = new GuestDetails("Ines Lark", "guest@example.com", null);
    Reservation booked =
        holds.confirm(
            holds
                .create("quay-house", "double", WEEK, 1, 3, guest, RatePlan.NON_REFUNDABLE)
                .getId());

    assertThat(booked.getTotal().amount()).isEqualByComparingTo("710.10");
    assertThat(payments.movements()).hasSize(1);
    assertThat(payments.movements().get(0).amount().amount()).isEqualByComparingTo("710.10");

    var outcome = reservations.cancel(booked.getReference());

    assertThat(outcome.refund().isZero()).isTrue();
    assertThat(payments.refundCount()).isZero();
    assertThat(booked(room, LocalDate.parse("2027-06-11"))).isZero();
  }
}
