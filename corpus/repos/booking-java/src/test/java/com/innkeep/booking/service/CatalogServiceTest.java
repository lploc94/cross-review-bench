package com.innkeep.booking.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.clearInvocations;
import static org.mockito.Mockito.inOrder;

import com.innkeep.booking.domain.ConflictException;
import com.innkeep.booking.domain.NotFoundException;
import com.innkeep.booking.domain.Property;
import com.innkeep.booking.domain.RoomType;
import com.innkeep.booking.domain.ValidationException;
import com.innkeep.booking.persistence.InventoryRepository;
import com.innkeep.booking.support.IntegrationTestBase;
import java.time.LocalDate;
import java.time.LocalTime;
import java.util.List;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;

class CatalogServiceTest extends IntegrationTestBase {

  private static final LocalDate JUNE_1 = LocalDate.parse("2027-06-01");
  private static final LocalDate JUNE_2 = LocalDate.parse("2027-06-02");

  @Autowired private CatalogService catalog;

  @MockitoSpyBean private InventoryRepository inventoryRows;

  private Property property;
  private RoomType room;

  @BeforeEach
  void setUp() {
    property = data.harbourHouse();
    room = data.roomType(property, "double", 2, "100.00");
    data.rooms(property, room, JUNE_1, JUNE_2.plusDays(1), 2);
  }

  @Test
  void nightsAreWrittenInAscendingOrderWhateverTheRequestOrder() {
    clearInvocations(inventoryRows);

    catalog.setInventory(
        property.getCode(),
        room.getCode(),
        List.of(new NightTotal(JUNE_2, 3), new NightTotal(JUNE_1, 3)));

    // A hold takes its nights in ascending order; the same order here means no lock cycle.
    var order = inOrder(inventoryRows);
    order.verify(inventoryRows).findByRoomTypeIdAndNight(room.getId(), JUNE_1);
    order.verify(inventoryRows).findByRoomTypeIdAndNight(room.getId(), JUNE_2);
  }

  @Test
  void setInventoryUpdatesExistingNightsAndCreatesMissingOnes() {
    catalog.setInventory(
        property.getCode(),
        room.getCode(),
        List.of(new NightTotal(JUNE_1, 5), new NightTotal(JUNE_2.plusDays(1), 3)));

    assertThat(totalOn(JUNE_1)).isEqualTo(5);
    assertThat(totalOn(JUNE_2.plusDays(1))).isEqualTo(3);
  }

  @Test
  void aTotalBelowTheRoomsInUseIsRefusedAndNothingIsWritten() {
    data.hold(property, room, JUNE_1, JUNE_2, 1);

    assertThatThrownBy(
            () ->
                catalog.setInventory(
                    property.getCode(),
                    room.getCode(),
                    List.of(new NightTotal(JUNE_2, 0), new NightTotal(JUNE_1, 0))))
        .isInstanceOf(ConflictException.class);
    assertThat(totalOn(JUNE_2)).isEqualTo(2);
    assertThat(totalOn(JUNE_1)).isEqualTo(2);
  }

  @Test
  void aNightListedTwiceIsRefused() {
    assertThatThrownBy(
            () ->
                catalog.setInventory(
                    property.getCode(),
                    room.getCode(),
                    List.of(new NightTotal(JUNE_1, 1), new NightTotal(JUNE_1, 2))))
        .isInstanceOf(ValidationException.class);
  }

  @Test
  void aFixedOffsetIsNotAcceptedAsATimeZone() {
    for (String offset : List.of("+01:00", "UTC+01:00", "Z")) {
      assertThatThrownBy(
              () ->
                  catalog.updateDetails(
                      property.getCode(),
                      "Harbour House",
                      offset,
                      LocalTime.of(15, 0),
                      LocalTime.of(11, 0)))
          .isInstanceOf(ValidationException.class)
          .hasMessageContaining("IANA");
    }
    assertThat(
            catalog
                .updateDetails(
                    property.getCode(),
                    "Harbour House",
                    "Europe/Madrid",
                    LocalTime.of(15, 0),
                    LocalTime.of(11, 0))
                .zone())
        .hasToString("Europe/Madrid");
  }

  @Test
  void anEmptyListIsRefused() {
    assertThatThrownBy(() -> catalog.setInventory(property.getCode(), room.getCode(), List.of()))
        .isInstanceOf(ValidationException.class);
  }

  @Test
  void unknownPropertyAndRoomTypeAreNotFound() {
    assertThatThrownBy(() -> catalog.property("no-such-house"))
        .isInstanceOf(NotFoundException.class);
    assertThatThrownBy(() -> catalog.roomType(property.getCode(), "penthouse"))
        .isInstanceOf(NotFoundException.class);
  }

  private int totalOn(LocalDate night) {
    return jdbc.queryForObject(
        "select total from inventory where room_type_id = ? and night = ?",
        Integer.class,
        room.getId(),
        java.sql.Date.valueOf(night));
  }
}
