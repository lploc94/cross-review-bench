package com.innkeep.booking.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.innkeep.booking.domain.DateRange;
import com.innkeep.booking.domain.Property;
import com.innkeep.booking.domain.RoomType;
import com.innkeep.booking.domain.StayRestrictedException;
import com.innkeep.booking.support.IntegrationTestBase;
import java.time.LocalDate;
import java.util.List;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

/** Minimum stay and closed-to-arrival bind the arrival night only; staying through is fine. */
class ArrivalNightRestrictionTest extends IntegrationTestBase {

  @Autowired private StayRestrictionService restrictions;
  @Autowired private PricingService pricing;

  private Property property;
  private RoomType room;

  @BeforeEach
  void setUp() {
    property = data.harbourHouse();
    room = data.roomType(property, "double", 2, "100.00");
    data.rooms(property, room, LocalDate.parse("2027-06-01"), LocalDate.parse("2027-06-30"), 5);
  }

  private static LocalDate day(int dayOfJune) {
    return LocalDate.of(2027, 6, dayOfJune);
  }

  private void quote(int in, int out) {
    pricing.quote("harbour-house", "double", new DateRange(day(in), day(out)), 1, 2);
  }

  private void refused(int in, int out, String rule) {
    assertThatThrownBy(() -> quote(in, out))
        .isInstanceOfSatisfying(
            StayRestrictedException.class,
            e -> {
              assertThat(e.rule()).isEqualTo(rule);
              assertThat(e.night()).isEqualTo(day(in));
            });
    assertThatThrownBy(() -> data.hold(property, room, day(in), day(out), 1))
        .isInstanceOf(StayRestrictedException.class);
    assertThat(held(room, day(in))).isZero();
  }

  private void allowed(int in, int out) {
    assertThatCode(() -> quote(in, out)).doesNotThrowAnyException();
    assertThatCode(() -> data.hold(property, room, day(in), day(out), 1))
        .doesNotThrowAnyException();
  }

  @Test
  void aMinimumStayBindsOnlyStaysArrivingOnACoveredNight() {
    restrictions.replace(
        "harbour-house", "double", List.of(new StayRestrictionDraft(day(10), day(12), 3, false)));

    refused(10, 12, "min-stay");
    refused(12, 14, "min-stay");
    allowed(10, 13);
    allowed(12, 15);
    // arriving the night before, or after the range, the minimum does not apply
    allowed(9, 11);
    allowed(8, 14);
    allowed(13, 14);
  }

  @Test
  void closedToArrivalRefusesArrivalsButNotStaysThatRunThrough() {
    restrictions.replace(
        "harbour-house", "double", List.of(new StayRestrictionDraft(day(20), day(20), null, true)));

    refused(20, 22, "closed-to-arrival");
    refused(20, 21, "closed-to-arrival");
    allowed(19, 22);
    allowed(18, 20);
    allowed(21, 22);
  }
}
