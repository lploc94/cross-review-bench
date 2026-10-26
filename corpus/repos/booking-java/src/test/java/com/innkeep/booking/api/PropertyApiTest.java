package com.innkeep.booking.api;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.innkeep.booking.support.IntegrationTestBase;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;

class PropertyApiTest extends IntegrationTestBase {

  @BeforeEach
  void setUp() {
    var property = data.harbourHouse();
    data.roomType(property, "suite", 4, "200.00");
    data.roomType(property, "double", 2, "100.00");
  }

  @Test
  void aPropertyIsReadWithItsZoneAndCurrency() throws Exception {
    mvc.perform(get("/api/v1/properties/harbour-house"))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.code").value("harbour-house"))
        .andExpect(jsonPath("$.timeZone").value("Europe/Lisbon"))
        .andExpect(jsonPath("$.currency").value("EUR"))
        .andExpect(jsonPath("$.checkInTime").exists());
  }

  @Test
  void anUnknownPropertyAnswersAProblemDetail() throws Exception {
    mvc.perform(get("/api/v1/properties/no-such-house"))
        .andExpect(status().isNotFound())
        .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
        .andExpect(jsonPath("$.type").value("urn:innkeep:problem:not-found"))
        .andExpect(jsonPath("$.status").value(404));
  }

  @Test
  void roomTypesAreListedByCode() throws Exception {
    mvc.perform(get("/api/v1/properties/harbour-house/room-types"))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$[0].code").value("double"))
        .andExpect(jsonPath("$[1].code").value("suite"))
        .andExpect(jsonPath("$[1].capacity").value(4));
  }
}
