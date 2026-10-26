package com.innkeep.booking.api;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.innkeep.booking.support.IntegrationTestBase;
import com.jayway.jsonpath.JsonPath;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;

class SeasonalRateUpdateApiTest extends IntegrationTestBase {

  private static final String RATES =
      "/api/v1/admin/properties/harbour-house/room-types/double/seasonal-rates";

  @BeforeEach
  void setUp() {
    data.roomType(data.harbourHouse(), "double", 2, "100.00");
  }

  @Test
  void aSeasonalRateMayKeepItsOwnNightsWhenItIsChanged() throws Exception {
    long june = addRate("2027-06-01", "2027-06-30", 1);
    mvc.perform(
            put(RATES + "/" + june)
                .header("Authorization", ADMIN_AUTH)
                .contentType(MediaType.APPLICATION_JSON)
                .content(rate("2027-06-01", "2027-06-30", 150.00, 1)))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.nightlyRate").value(150.00));
  }

  @Test
  void aRateBeyondWhatPricesCanStoreIsAnInvalidRequest() throws Exception {
    mvc.perform(
            post(RATES)
                .header("Authorization", ADMIN_AUTH)
                .contentType(MediaType.APPLICATION_JSON)
                .content(rate("2027-06-01", "2027-06-30", 1.0e11, 1)))
        .andExpect(status().isBadRequest())
        .andExpect(jsonPath("$.type").value("urn:innkeep:problem:invalid-request"));
  }

  @Test
  void aChangeThatOverlapsAnotherRateOfTheSamePriorityIsAConflict() throws Exception {
    long june = addRate("2027-06-01", "2027-06-30", 1);
    addRate("2027-07-01", "2027-07-31", 1);
    mvc.perform(
            put(RATES + "/" + june)
                .header("Authorization", ADMIN_AUTH)
                .contentType(MediaType.APPLICATION_JSON)
                .content(rate("2027-06-20", "2027-07-05", 140.00, 1)))
        .andExpect(status().isConflict());
    mvc.perform(
            put(RATES + "/" + june)
                .header("Authorization", ADMIN_AUTH)
                .contentType(MediaType.APPLICATION_JSON)
                .content(rate("2027-06-20", "2027-07-05", 140.00, 2)))
        .andExpect(status().isOk());
  }

  @Test
  void aRateOfAnotherRoomTypeIsNotFound() throws Exception {
    long june = addRate("2027-06-01", "2027-06-30", 1);
    mvc.perform(
            put("/api/v1/admin/properties/harbour-house/room-types/other/seasonal-rates/" + june)
                .header("Authorization", ADMIN_AUTH)
                .contentType(MediaType.APPLICATION_JSON)
                .content(rate("2027-06-01", "2027-06-30", 150.00, 1)))
        .andExpect(status().isNotFound());
  }

  @Test
  void aWrongMethodAnswersWithTheAllowedOnes() throws Exception {
    mvc.perform(delete("/api/v1/properties/harbour-house"))
        .andExpect(status().isMethodNotAllowed())
        .andExpect(header().exists("Allow"))
        .andExpect(jsonPath("$.type").value("urn:innkeep:problem:method-not-allowed"));
  }

  @Test
  void aMissingParameterIsNamedInTheProblem() throws Exception {
    mvc.perform(
            get("/api/v1/properties/harbour-house/room-types/double/calendar")
                .param("checkIn", "2027-06-01"))
        .andExpect(status().isBadRequest())
        .andExpect(jsonPath("$.detail").value("the parameter checkOut is required"));
  }

  private long addRate(String start, String end, int priority) throws Exception {
    String body =
        mvc.perform(
                post(RATES)
                    .header("Authorization", ADMIN_AUTH)
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(rate(start, end, 130.00, priority)))
            .andExpect(status().isCreated())
            .andReturn()
            .getResponse()
            .getContentAsString();
    return ((Number) JsonPath.read(body, "$.id")).longValue();
  }

  private static String rate(String start, String end, double amount, int priority) {
    return "{\"startDate\":\""
        + start
        + "\",\"endDate\":\""
        + end
        + "\",\"nightlyRate\":"
        + amount
        + ",\"priority\":"
        + priority
        + "}";
  }
}
