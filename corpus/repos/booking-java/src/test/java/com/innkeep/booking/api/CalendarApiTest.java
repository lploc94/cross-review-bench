package com.innkeep.booking.api;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.innkeep.booking.domain.Property;
import com.innkeep.booking.domain.RoomType;
import com.innkeep.booking.support.IntegrationTestBase;
import java.time.LocalDate;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;

class CalendarApiTest extends IntegrationTestBase {

  private static final String CALENDAR =
      "/api/v1/properties/harbour-house/room-types/double/calendar";

  private Property property;
  private RoomType room;

  @BeforeEach
  void setUp() {
    property = data.harbourHouse();
    room = data.roomType(property, "double", 2, "100.00");
    data.rooms(property, room, LocalDate.parse("2027-05-01"), LocalDate.parse("2027-05-04"), 4);
  }

  @Test
  void theCalendarPricesEachNightWithTheWeekendSurcharge() throws Exception {
    mvc.perform(get(CALENDAR).param("checkIn", "2027-05-01").param("checkOut", "2027-05-04"))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.length()").value(3))
        .andExpect(jsonPath("$[0].night").value("2027-05-01"))
        .andExpect(jsonPath("$[0].nightlyRate").value(110.00))
        .andExpect(jsonPath("$[0].weekendSurcharge").value(true))
        .andExpect(jsonPath("$[0].available").value(4))
        .andExpect(jsonPath("$[0].currency").value("EUR"))
        .andExpect(jsonPath("$[1].nightlyRate").value(100.00))
        .andExpect(jsonPath("$[1].weekendSurcharge").value(false));
  }

  @Test
  void aSeasonalRateShowsOnTheNightsItCovers() throws Exception {
    mvc.perform(
            post("/api/v1/admin/properties/harbour-house/room-types/double/seasonal-rates")
                .header("Authorization", ADMIN_AUTH)
                .contentType(MediaType.APPLICATION_JSON)
                .content(
                    "{\"startDate\":\"2027-05-02\",\"endDate\":\"2027-05-03\","
                        + "\"nightlyRate\":150.00,\"priority\":1}"))
        .andExpect(status().isCreated());

    mvc.perform(get(CALENDAR).param("checkIn", "2027-05-01").param("checkOut", "2027-05-04"))
        .andExpect(jsonPath("$[1].nightlyRate").value(150.00))
        .andExpect(jsonPath("$[1].seasonalRate").value(true))
        .andExpect(jsonPath("$[0].seasonalRate").value(false));
  }

  @Test
  void aNightWithoutInventoryShowsNoRoomsFree() throws Exception {
    mvc.perform(get(CALENDAR).param("checkIn", "2027-05-03").param("checkOut", "2027-05-05"))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$[0].available").value(4))
        .andExpect(jsonPath("$[1].available").value(0));
  }

  @Test
  void anEmptyOrBackwardsRangeIsRefused() throws Exception {
    mvc.perform(get(CALENDAR).param("checkIn", "2027-05-04").param("checkOut", "2027-05-01"))
        .andExpect(status().isBadRequest())
        .andExpect(jsonPath("$.type").value("urn:innkeep:problem:invalid-request"));
  }

  @Test
  void occupancyCountsHeldAndBookedRoomsPerNight() throws Exception {
    data.book(property, room, LocalDate.parse("2027-05-01"), LocalDate.parse("2027-05-02"), 1);

    mvc.perform(
            get("/api/v1/properties/harbour-house/occupancy")
                .param("checkIn", "2027-05-01")
                .param("checkOut", "2027-05-03"))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.length()").value(2))
        .andExpect(jsonPath("$[0].totalRooms").value(4))
        .andExpect(jsonPath("$[0].bookedRooms").value(1))
        .andExpect(jsonPath("$[0].percentInUse").value(25.0))
        .andExpect(jsonPath("$[1].percentInUse").value(0.0));
  }

  @Test
  void aNightWithNoInventoryReportsZeroRoomsAndZeroPercent() throws Exception {
    mvc.perform(
            get("/api/v1/properties/harbour-house/occupancy")
                .param("checkIn", "2027-05-03")
                .param("checkOut", "2027-05-05"))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$[1].night").value("2027-05-04"))
        .andExpect(jsonPath("$[1].totalRooms").value(0))
        .andExpect(jsonPath("$[1].percentInUse").value(0.0));
  }

  @Test
  void theRoomTypeIsReadWithItsProperty() throws Exception {
    mvc.perform(get("/api/v1/properties/harbour-house/room-types/double"))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.code").value("double"))
        .andExpect(jsonPath("$.currency").value("EUR"));
  }
}
