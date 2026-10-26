package com.innkeep.booking.api;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.innkeep.booking.support.IntegrationTestBase;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;

class QuoteApiTest extends IntegrationTestBase {

  @BeforeEach
  void setUp() {
    var property = data.harbourHouse();
    var room = data.roomType(property, "double", 2, "100.00");
    data.rooms(
        property,
        room,
        java.time.LocalDate.parse("2027-06-01"),
        java.time.LocalDate.parse("2027-06-12"),
        2);
  }

  @Test
  void aQuoteShowsEveryLineAndTheTotal() throws Exception {
    String body =
        "{\"roomType\":\"double\",\"checkIn\":\"2027-06-10\",\"checkOut\":\"2027-06-12\","
            + "\"rooms\":1,\"guests\":2}";

    mvc.perform(
            post("/api/v1/properties/harbour-house/quotes")
                .contentType(MediaType.APPLICATION_JSON)
                .content(body))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.total").value(210.00))
        .andExpect(jsonPath("$.currency").value("EUR"))
        .andExpect(jsonPath("$.lines.length()").value(2))
        .andExpect(jsonPath("$.lines[1].description").value("Room night"));
  }

  @Test
  void anInvalidRequestListsItsFieldErrors() throws Exception {
    String body =
        "{\"roomType\":\"\",\"checkIn\":\"2027-06-10\",\"checkOut\":\"2027-06-12\","
            + "\"rooms\":0,\"guests\":2}";

    mvc.perform(
            post("/api/v1/properties/harbour-house/quotes")
                .contentType(MediaType.APPLICATION_JSON)
                .content(body))
        .andExpect(status().isBadRequest())
        .andExpect(jsonPath("$.type").value("urn:innkeep:problem:validation-failed"))
        .andExpect(jsonPath("$.errors.length()").value(2));
  }

  @Test
  void aMalformedBodyIsABadRequest() throws Exception {
    mvc.perform(
            post("/api/v1/properties/harbour-house/quotes")
                .contentType(MediaType.APPLICATION_JSON)
                .content("{not json"))
        .andExpect(status().isBadRequest())
        .andExpect(jsonPath("$.type").value("urn:innkeep:problem:malformed-request"));
  }
}
