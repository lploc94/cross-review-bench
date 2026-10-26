package com.innkeep.booking.unit;

import static org.assertj.core.api.Assertions.assertThat;

import com.innkeep.booking.domain.CancellationPolicy;
import com.innkeep.booking.domain.Money;
import com.innkeep.booking.domain.Property;
import com.innkeep.booking.support.Fixtures;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.util.Currency;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

/**
 * Refund tiers: full refund until seven days before check-in (at the property's check-in time, in
 * its zone), partial refund until check-in, nothing after. The deadlines cross DST changes, where
 * adding 168 hours in UTC would be an hour off.
 */
class CancellationPolicyTest {

  private static final String LISBON = "Europe/Lisbon";

  private static CancellationPolicy lisbon() {
    return CancellationPolicy.of(Fixtures.property(LISBON, 0, 0));
  }

  @Test
  void fullRefundDeadlineIsOneHourEarlierAfterTheSpringForwardChange() {
    // 2027-03-28 is the spring change in Lisbon. 2027-03-29 15:00 is WEST (+01:00): 14:00Z, not
    // 15:00Z
    Instant deadline = lisbon().fullRefundDeadline(LocalDate.parse("2027-04-05"));

    assertThat(deadline).isEqualTo(Instant.parse("2027-03-29T14:00:00Z"));
  }

  @Test
  void theBoundaryIsExactAcrossTheSpringChange() {
    var checkIn = LocalDate.parse("2027-04-05");
    var policy = lisbon();

    assertThat(policy.refundPercent(checkIn, Instant.parse("2027-03-29T13:59:59.999999999Z")))
        .isEqualTo(100);
    assertThat(policy.refundPercent(checkIn, Instant.parse("2027-03-29T14:00:00Z"))).isEqualTo(100);
    assertThat(policy.refundPercent(checkIn, Instant.parse("2027-03-29T14:00:00.000000001Z")))
        .isEqualTo(50);
  }

  @Test
  void checkInMomentIsExactAcrossTheSpringChange() {
    var checkIn = LocalDate.parse("2027-04-05");
    var policy = lisbon();

    assertThat(policy.checkInMoment(checkIn)).isEqualTo(Instant.parse("2027-04-05T14:00:00Z"));
    assertThat(policy.refundPercent(checkIn, Instant.parse("2027-04-05T13:59:59.999Z")))
        .isEqualTo(50);
    assertThat(policy.refundPercent(checkIn, Instant.parse("2027-04-05T14:00:00Z"))).isEqualTo(0);
  }

  @Test
  void theBoundaryIsExactAcrossTheAutumnChange() {
    // Lisbon returns to WET on 2027-10-31: the deadline 2027-10-25 15:00 is still WEST (14:00Z),
    // and the check-in on 2027-11-01 15:00 is WET (15:00Z)
    var checkIn = LocalDate.parse("2027-11-01");
    var policy = lisbon();

    assertThat(policy.fullRefundDeadline(checkIn)).isEqualTo(Instant.parse("2027-10-25T14:00:00Z"));
    assertThat(policy.refundPercent(checkIn, Instant.parse("2027-10-25T13:59:59.999999999Z")))
        .isEqualTo(100);
    assertThat(policy.refundPercent(checkIn, Instant.parse("2027-10-25T14:00:00Z"))).isEqualTo(100);
    assertThat(policy.refundPercent(checkIn, Instant.parse("2027-10-25T14:00:00.000000001Z")))
        .isEqualTo(50);
    assertThat(policy.checkInMoment(checkIn)).isEqualTo(Instant.parse("2027-11-01T15:00:00Z"));
  }

  @Test
  void theZoneOfThePropertyDecidesNotUtc() {
    var auckland = CancellationPolicy.of(Fixtures.property("Pacific/Auckland", 0, 0));

    // 15:00 NZST is UTC+12 in June: the deadline is 03:00Z, not 15:00Z
    assertThat(auckland.fullRefundDeadline(LocalDate.parse("2027-06-10")))
        .isEqualTo(Instant.parse("2027-06-03T03:00:00Z"));
  }

  @ParameterizedTest
  @CsvSource({
    "2027-06-01T10:00:00Z, 300.00",
    "2027-06-05T10:00:00Z, 150.00",
    "2027-06-10T14:00:00Z, 0.00"
  })
  void refundFollowsTheTierAtTheCancellationInstant(String at, String amount) {
    Property property = Fixtures.property(LISBON, 0, 0);
    Money paid = Money.of(new BigDecimal("300.00"), Currency.getInstance("EUR"));

    Money refund =
        CancellationPolicy.of(property)
            .refund(paid, LocalDate.parse("2027-06-10"), Instant.parse(at));

    assertThat(refund.amount()).isEqualByComparingTo(amount);
  }
}
