package com.innkeep.booking.service;

import static org.assertj.core.api.Assertions.assertThat;

import com.innkeep.booking.domain.DateRange;
import com.innkeep.booking.domain.Property;
import com.innkeep.booking.domain.RoomType;
import com.innkeep.booking.support.IntegrationTestBase;
import java.time.LocalDate;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

class AvailabilityServiceTest extends IntegrationTestBase {

  private static final LocalDate JUNE_1 = LocalDate.parse("2027-06-01");
  private static final LocalDate JUNE_4 = LocalDate.parse("2027-06-04");

  @Autowired private AvailabilityService availability;

  private Property property;
  private RoomType doubleRoom;

  @BeforeEach
  void setUp() {
    property = data.harbourHouse();
    doubleRoom = data.roomType(property, "double", 2, "100.00");
    RoomType suite = data.roomType(property, "suite", 4, "200.00");
    RoomType twin = data.roomType(property, "twin", 2, "90.00");
    data.rooms(property, doubleRoom, JUNE_1, JUNE_4, 2);
    data.rooms(property, suite, JUNE_1, LocalDate.parse("2027-06-03"), 1);
    data.rooms(property, suite, LocalDate.parse("2027-06-03"), JUNE_4, 0);
    data.rooms(property, twin, JUNE_1, LocalDate.parse("2027-06-03"), 2);
  }

  @Test
  void listsOnlyRoomTypesFreeOnEveryNightWithTheQuotedTotal() {
    var rows = availability.search(property.getCode(), new DateRange(JUNE_1, JUNE_4), 1, 2);

    assertThat(rows).extracting(AvailabilityRow::roomTypeCode).containsExactly("double");
    assertThat(rows.get(0).availableRooms()).isEqualTo(2);
    assertThat(rows.get(0).quotedTotal().amount().toPlainString()).isEqualTo("300.00");
  }

  @Test
  void roomsRequestedMustBeFreeOnEveryNight() {
    data.hold(property, doubleRoom, JUNE_1, JUNE_4, 1);

    var rows = availability.search(property.getCode(), new DateRange(JUNE_1, JUNE_4), 2, 2);

    assertThat(rows).isEmpty();
    var single = availability.search(property.getCode(), new DateRange(JUNE_1, JUNE_4), 1, 2);
    assertThat(single).extracting(AvailabilityRow::availableRooms).containsExactly(1);
  }

  @Test
  void guestsAboveTheRoomLimitAreExcluded() {
    var range = new DateRange(JUNE_1, JUNE_4);

    assertThat(availability.search(property.getCode(), range, 1, 4)).hasSize(1);
    assertThat(availability.search(property.getCode(), range, 1, 5)).isEmpty();
  }

  @Test
  void aNightWithoutAnInventoryRowOrWithNoRoomsRemovesTheRoomType() {
    var rows = availability.search(property.getCode(), new DateRange(JUNE_1, JUNE_4), 1, 2);

    assertThat(rows).extracting(AvailabilityRow::roomTypeCode).doesNotContain("twin", "suite");
  }
}
