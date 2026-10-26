package com.innkeep.booking.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.innkeep.booking.domain.DateRange;
import com.innkeep.booking.domain.GuestDetails;
import com.innkeep.booking.domain.Hold;
import com.innkeep.booking.domain.PriceKind;
import com.innkeep.booking.domain.Property;
import com.innkeep.booking.domain.Quote;
import com.innkeep.booking.domain.RoomType;
import com.innkeep.booking.domain.ValidationException;
import com.innkeep.booking.support.IntegrationTestBase;
import java.time.Instant;
import java.time.LocalDate;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

/** validFrom and validUntil are both days on which the code can be used at the property. */
class PromoValidityDaysTest extends IntegrationTestBase {

  private static final LocalDate IN = LocalDate.parse("2027-06-01");
  private static final LocalDate OUT = LocalDate.parse("2027-06-03");

  @Autowired private HoldService holds;
  @Autowired private PricingService pricing;
  @Autowired private PromoService promos;

  private Property property;
  private RoomType room;

  @BeforeEach
  void setUp() {
    property = data.harbourHouse();
    room = data.roomType(property, "double", 2, "100.00");
    data.rooms(property, room, IN, OUT, 4);
    promos.create(
        property.getCode(),
        new PromoCodeDraft(
            "MAYDAYS", 10, null, LocalDate.parse("2027-05-01"), LocalDate.parse("2027-05-10"), 5));
  }

  @Test
  void theFirstValidDayAccepts() {
    // 2027-05-01T10:00Z is 11:00 on 1 May in Lisbon
    clock.set(Instant.parse("2027-05-01T10:00:00Z"));

    assertThat(quote().total().amount()).isEqualByComparingTo("180.00");
  }

  @Test
  void theLastValidDayAccepts() {
    // 23:30 on 10 May in Lisbon (UTC+1)
    clock.set(Instant.parse("2027-05-10T22:30:00Z"));

    assertThat(quote().total().amount()).isEqualByComparingTo("180.00");
    Hold hold = hold();
    assertThat(hold.getPriceLines()).anyMatch(line -> line.getKind() == PriceKind.PROMO);
    assertThat(hold.getTotal().amount()).isEqualByComparingTo("180.00");
  }

  @Test
  void theDayAfterTheLastValidDayRefuses() {
    // 00:30 on 11 May in Lisbon
    clock.set(Instant.parse("2027-05-10T23:30:00Z"));

    assertThatThrownBy(this::quote).isInstanceOf(ValidationException.class);
    assertThatThrownBy(this::hold).isInstanceOf(ValidationException.class);
  }

  private Quote quote() {
    return pricing.quote(
        property.getCode(), room.getCode(), new DateRange(IN, OUT), 1, 2, "maydays");
  }

  private Hold hold() {
    return holds.create(
        property.getCode(),
        room.getCode(),
        new DateRange(IN, OUT),
        1,
        2,
        new GuestDetails("Ada Wren", "ada@example.com", null),
        "maydays");
  }
}
