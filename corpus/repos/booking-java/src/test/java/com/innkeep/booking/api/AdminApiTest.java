package com.innkeep.booking.api;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.innkeep.booking.support.IntegrationTestBase;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;

class AdminApiTest extends IntegrationTestBase {

  private static final String PATH =
      "/api/v1/admin/properties/harbour-house/room-types/double/inventory";
  private static final String FOUR_NIGHTS =
      "{\"nights\":[{\"date\":\"2027-06-01\",\"total\":4},{\"date\":\"2027-06-02\",\"total\":4}]}";

  @BeforeEach
  void setUp() {
    var property = data.harbourHouse();
    data.roomType(property, "double", 2, "100.00");
  }

  @Test
  void theAdminRoutesRequireTheAdminToken() throws Exception {
    mvc.perform(put(PATH).contentType(MediaType.APPLICATION_JSON).content(FOUR_NIGHTS))
        .andExpect(status().isUnauthorized())
        .andExpect(header().string("WWW-Authenticate", "Bearer"));
    mvc.perform(
            put(PATH)
                .header("Authorization", "Bearer guessed-token")
                .contentType(MediaType.APPLICATION_JSON)
                .content(FOUR_NIGHTS))
        .andExpect(status().isUnauthorized());
  }

  @Test
  void aNullNightInTheListIsA400() throws Exception {
    mvc.perform(
            put(PATH)
                .header("Authorization", ADMIN_AUTH)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"nights\":[null]}"))
        .andExpect(status().isBadRequest());
  }

  @Test
  void aValidTokenSetsTheInventoryAndAvailabilityReflectsIt() throws Exception {
    mvc.perform(
            put(PATH)
                .header("Authorization", ADMIN_AUTH)
                .contentType(MediaType.APPLICATION_JSON)
                .content(FOUR_NIGHTS))
        .andExpect(status().isNoContent());

    mvc.perform(
            get("/api/v1/properties/harbour-house/availability")
                .param("checkIn", "2027-06-01")
                .param("checkOut", "2027-06-03")
                .param("rooms", "4"))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$[0].roomType").value("double"))
        .andExpect(jsonPath("$[0].availableRooms").value(4));
  }

  @Test
  void anEmptyNightListIsRefused() throws Exception {
    mvc.perform(
            put(PATH)
                .header("Authorization", ADMIN_AUTH)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"nights\":[]}"))
        .andExpect(status().isBadRequest());
  }

  @Test
  void aNegativeTotalIsRefused() throws Exception {
    mvc.perform(
            put(PATH)
                .header("Authorization", ADMIN_AUTH)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"nights\":[{\"date\":\"2027-06-01\",\"total\":-1}]}"))
        .andExpect(status().isBadRequest());
  }

  @Test
  void anUnknownRoomTypeIsNotFound() throws Exception {
    mvc.perform(
            put("/api/v1/admin/properties/harbour-house/room-types/penthouse/inventory")
                .header("Authorization", ADMIN_AUTH)
                .contentType(MediaType.APPLICATION_JSON)
                .content(FOUR_NIGHTS))
        .andExpect(status().isNotFound());
  }
}
