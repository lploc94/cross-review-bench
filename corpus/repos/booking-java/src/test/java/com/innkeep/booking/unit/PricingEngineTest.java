package com.innkeep.booking.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.innkeep.booking.domain.DateRange;
import com.innkeep.booking.domain.PriceKind;
import com.innkeep.booking.domain.PricingEngine;
import com.innkeep.booking.domain.Property;
import com.innkeep.booking.domain.Quote;
import com.innkeep.booking.domain.RoomType;
import com.innkeep.booking.domain.SeasonalRate;
import com.innkeep.booking.domain.ValidationException;
import com.innkeep.booking.support.Fixtures;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

/** Pure pricing rules: no database, no Spring. Dates are 2027 weekdays: 1 Jan is a Friday. */
class PricingEngineTest {

  private static final String LISBON = "Europe/Lisbon";

  private static DateRange stay(String in, String out) {
    return new DateRange(LocalDate.parse(in), LocalDate.parse(out));
  }

  @Test
  void chargesTheBaseRatePerNightAndRoom() {
    Property property = Fixtures.property(LISBON, 0, 0);
    RoomType room = Fixtures.roomType(property, 2, "100.00");

    Quote quote =
        PricingEngine.quote(property, room, List.of(), stay("2027-01-04", "2027-01-06"), 1, 2);

    assertThat(quote.total().amount()).isEqualByComparingTo("200.00");
    assertThat(quote.lines()).hasSize(2);
    assertThat(quote.lines()).allMatch(line -> line.getKind() == PriceKind.NIGHTLY_RATE);
  }

  @Test
  void weekendSurchargeAppliesToFridayAndSaturdayNightsOnly() {
    Property property = Fixtures.property(LISBON, 10, 0);
    RoomType room = Fixtures.roomType(property, 2, "100.00");

    Quote quote =
        PricingEngine.quote(property, room, List.of(), stay("2027-01-07", "2027-01-10"), 1, 2);

    assertThat(quote.lines().get(0).getAmount()).isEqualByComparingTo("100.00");
    assertThat(quote.lines().get(1).getAmount()).isEqualByComparingTo("110.00");
    assertThat(quote.lines().get(2).getAmount()).isEqualByComparingTo("110.00");
    assertThat(quote.total().amount()).isEqualByComparingTo("320.00");
  }

  @Test
  void weekendSurchargeIsDecidedByTheNightDate() {
    Property property = Fixtures.property(LISBON, 10, 0);
    RoomType room = Fixtures.roomType(property, 2, "100.00");

    Quote friday =
        PricingEngine.quote(property, room, List.of(), stay("2027-01-01", "2027-01-02"), 1, 2);
    Quote thursday =
        PricingEngine.quote(property, room, List.of(), stay("2027-01-07", "2027-01-08"), 1, 2);

    assertThat(friday.total().amount()).isEqualByComparingTo("110.00");
    assertThat(thursday.total().amount()).isEqualByComparingTo("100.00");
  }

  @Test
  void weekendSurchargeRoundsHalfToEven() {
    Property property = Fixtures.property(LISBON, 10, 0);
    RoomType room = Fixtures.roomType(property, 2, "0.25");

    // 10% of 0.25 is 0.025: half-even gives 0.02, half-up would give 0.03
    Quote quote =
        PricingEngine.quote(property, room, List.of(), stay("2027-01-01", "2027-01-02"), 1, 2);

    assertThat(quote.total().amount()).isEqualByComparingTo("0.27");
  }

  @Test
  void seasonalRateReplacesTheBaseRateOnItsNights() {
    Property property = Fixtures.property(LISBON, 0, 0);
    RoomType room = Fixtures.roomType(property, 2, "100.00");
    var summer =
        new SeasonalRate(
            room,
            LocalDate.parse("2027-07-01"),
            LocalDate.parse("2027-07-02"),
            new BigDecimal("150.00"),
            1);

    Quote quote =
        PricingEngine.quote(
            property, room, List.of(summer), stay("2027-06-30", "2027-07-03"), 1, 2);

    assertThat(quote.total().amount()).isEqualByComparingTo("400.00");
  }

  @Test
  void lowestPriorityNumberWinsWhenSeasonalRatesOverlap() {
    Property property = Fixtures.property(LISBON, 0, 0);
    RoomType room = Fixtures.roomType(property, 2, "100.00");
    var broad =
        new SeasonalRate(
            room,
            LocalDate.parse("2027-07-01"),
            LocalDate.parse("2027-07-03"),
            new BigDecimal("150.00"),
            2);
    var narrow =
        new SeasonalRate(
            room,
            LocalDate.parse("2027-07-02"),
            LocalDate.parse("2027-07-02"),
            new BigDecimal("120.00"),
            1);

    Quote quote =
        PricingEngine.quote(
            property, room, List.of(broad, narrow), stay("2027-07-01", "2027-07-03"), 1, 2);

    assertThat(quote.lines().get(0).getAmount()).isEqualByComparingTo("150.00");
    assertThat(quote.lines().get(1).getAmount()).isEqualByComparingTo("120.00");
  }

  @Test
  void lengthOfStayDiscountNeedsTheMinimumNights() {
    Property property = Fixtures.property(LISBON, 0, 10);
    RoomType room = Fixtures.roomType(property, 2, "100.00");

    Quote six =
        PricingEngine.quote(property, room, List.of(), stay("2027-01-04", "2027-01-10"), 1, 2);
    Quote seven =
        PricingEngine.quote(property, room, List.of(), stay("2027-01-04", "2027-01-11"), 1, 2);

    assertThat(six.total().amount()).isEqualByComparingTo("600.00");
    assertThat(six.lines()).noneMatch(line -> line.getKind() == PriceKind.LENGTH_OF_STAY_DISCOUNT);
    assertThat(seven.total().amount()).isEqualByComparingTo("630.00");
    assertThat(seven.lines())
        .anySatisfy(
            line -> {
              assertThat(line.getKind()).isEqualTo(PriceKind.LENGTH_OF_STAY_DISCOUNT);
              assertThat(line.getAmount()).isEqualByComparingTo("-70.00");
            });
  }

  @Test
  void extraGuestFeeIsPerNightAndNeverDiscounted() {
    Property property = Fixtures.property(LISBON, 0, 10);
    RoomType room = Fixtures.roomType(property, 2, "100.00");

    Quote quote =
        PricingEngine.quote(property, room, List.of(), stay("2027-01-04", "2027-01-11"), 1, 4);

    // room charges 700 less 10% = 630, plus 2 extra guests at 15.00 for each of 7 nights = 210
    assertThat(quote.total().amount()).isEqualByComparingTo("840.00");
    long fees =
        quote.lines().stream().filter(l -> l.getKind() == PriceKind.EXTRA_GUEST_FEE).count();
    assertThat(fees).isEqualTo(7);
  }

  @ParameterizedTest
  @ValueSource(ints = {0, 5})
  void rejectsGuestCountsOutsideTheRoomLimits(int guests) {
    Property property = Fixtures.property(LISBON, 0, 0);
    RoomType room = Fixtures.roomType(property, 2, "100.00");

    assertThatThrownBy(
            () ->
                PricingEngine.quote(
                    property, room, List.of(), stay("2027-01-04", "2027-01-05"), 1, guests))
        .isInstanceOf(ValidationException.class);
  }

  @Test
  void acceptsTheMaximumGuestsForTheRooms() {
    Property property = Fixtures.property(LISBON, 0, 0);
    RoomType room = Fixtures.roomType(property, 2, "100.00");

    Quote quote =
        PricingEngine.quote(property, room, List.of(), stay("2027-01-04", "2027-01-05"), 2, 8);

    assertThat(quote.guests()).isEqualTo(8);
    assertThat(quote.total().amount()).isEqualByComparingTo("260.00");
  }

  @Test
  void rejectsZeroRooms() {
    Property property = Fixtures.property(LISBON, 0, 0);
    RoomType room = Fixtures.roomType(property, 2, "100.00");

    assertThatThrownBy(
            () ->
                PricingEngine.quote(
                    property, room, List.of(), stay("2027-01-04", "2027-01-05"), 0, 1))
        .isInstanceOf(ValidationException.class);
  }
}
