package com.innkeep.booking.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.innkeep.booking.domain.DateRange;
import com.innkeep.booking.domain.InsufficientAvailabilityException;
import com.innkeep.booking.domain.Property;
import com.innkeep.booking.domain.RoomType;
import com.innkeep.booking.support.IntegrationTestBase;
import java.time.Instant;
import java.time.LocalDate;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

/** The release day is a date at the property, whatever the date is in UTC at that moment. */
class AllotmentReleaseDayTest extends IntegrationTestBase {

  private static final LocalDate MAY_5 = LocalDate.parse("2027-05-05");
  private static final DateRange ONE_NIGHT = new DateRange(MAY_5, MAY_5.plusDays(1));

  @Autowired private AllotmentService allotments;
  @Autowired private AvailabilityService availability;
  @Autowired private CalendarService calendar;

  /** Two rooms on May 5, both kept for a channel until May 2 (three days before). */
  private RoomType keptRooms(Property property) {
    RoomType room = data.roomType(property, "double", 2, "100.00");
    data.rooms(property, room, MAY_5, MAY_5.plusDays(1), 2);
    allotments.set(property.getCode(), room.getCode(), "atlas-travel", ONE_NIGHT, 2, 3);
    return room;
  }

  @Test
  void eastOfUtcTheRoomsAreReleasedWhenTheReleaseDayBeginsAtTheProperty() {
    Property property = data.property("kauri-lodge", "Pacific/Auckland", 0, 0);
    RoomType room = keptRooms(property);

    // 23:30 on May 1 in Auckland: still kept
    clock.set(Instant.parse("2027-05-01T11:30:00Z"));
    assertThat(availability.search(property.getCode(), ONE_NIGHT, 1, 2)).isEmpty();

    // 00:30 on May 2 in Auckland, still May 1 in UTC: released
    clock.set(Instant.parse("2027-05-01T12:30:00Z"));
    assertThat(availability.search(property.getCode(), ONE_NIGHT, 2, 2))
        .extracting(AvailabilityRow::availableRooms)
        .containsExactly(2);
    assertThat(calendar.calendar(property.getCode(), room.getCode(), ONE_NIGHT))
        .extracting(CalendarDay::available)
        .containsExactly(2);
    data.hold(property, room, MAY_5, MAY_5.plusDays(1), 2);
    assertThat(held(room, MAY_5)).isEqualTo(2);
  }

  @Test
  void westOfUtcTheRoomsStayKeptUntilTheReleaseDayBeginsAtTheProperty() {
    Property property = data.property("cedar-inn", "America/Los_Angeles", 0, 0);
    RoomType room = keptRooms(property);

    // 20:00 on May 1 in Los Angeles, already May 2 in UTC: still kept
    clock.set(Instant.parse("2027-05-02T03:00:00Z"));
    assertThat(availability.search(property.getCode(), ONE_NIGHT, 1, 2)).isEmpty();
    assertThat(calendar.calendar(property.getCode(), room.getCode(), ONE_NIGHT))
        .extracting(CalendarDay::available)
        .containsExactly(0);
    assertThatThrownBy(() -> data.hold(property, room, MAY_5, MAY_5.plusDays(1), 1))
        .isInstanceOf(InsufficientAvailabilityException.class);

    // 00:30 on May 2 in Los Angeles: released
    clock.set(Instant.parse("2027-05-02T07:30:00Z"));
    data.hold(property, room, MAY_5, MAY_5.plusDays(1), 2);
    assertThat(held(room, MAY_5)).isEqualTo(2);
  }
}
