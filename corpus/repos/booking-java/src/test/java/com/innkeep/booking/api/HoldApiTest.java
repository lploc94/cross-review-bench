package com.innkeep.booking.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.innkeep.booking.domain.Property;
import com.innkeep.booking.domain.RoomType;
import com.innkeep.booking.support.IntegrationTestBase;
import java.time.Duration;
import java.time.LocalDate;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MvcResult;

class HoldApiTest extends IntegrationTestBase {

  private static final String HOLD_BODY =
      "{\"stay\":{\"roomType\":\"double\",\"checkIn\":\"2027-06-01\",\"checkOut\":\"2027-06-03\","
          + "\"rooms\":1,\"guests\":2},"
          + "\"guest\":{\"name\":\"Mara Quill\",\"email\":\"guest@example.com\"}}";

  private Property property;
  private RoomType room;

  @BeforeEach
  void setUp() {
    property = data.harbourHouse();
    room = data.roomType(property, "double", 2, "100.00");
    data.rooms(property, room, LocalDate.parse("2027-06-01"), LocalDate.parse("2027-06-03"), 1);
  }

  @Test
  void aHoldWithoutAStayIsA400NamingTheField() throws Exception {
    String body = "{\"guest\":{\"name\":\"Mara Quill\",\"email\":\"guest@example.com\"}}";
    mvc.perform(
            post("/api/v1/properties/harbour-house/holds")
                .contentType(MediaType.APPLICATION_JSON)
                .content(body))
        .andExpect(status().isBadRequest())
        .andExpect(jsonPath("$.errors[0].field").value("stay"));
  }

  @Test
  void aHoldIsCreatedWithItsLocationAndQuote() throws Exception {
    MvcResult result =
        mvc.perform(
                post("/api/v1/properties/harbour-house/holds")
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(HOLD_BODY))
            .andExpect(status().isCreated())
            .andExpect(
                header().string("Location", org.hamcrest.Matchers.startsWith("/api/v1/holds/")))
            .andExpect(jsonPath("$.status").value("ACTIVE"))
            .andExpect(jsonPath("$.total").value(200.00))
            .andExpect(jsonPath("$.lines.length()").value(2))
            .andReturn();
    assertThat(result.getResponse().getContentAsString()).doesNotContain("guest@example.com");
  }

  @Test
  void aHoldThatDoesNotFitIsA409WithTheRightType() throws Exception {
    String body = HOLD_BODY.replace("\"rooms\":1", "\"rooms\":2");

    mvc.perform(
            post("/api/v1/properties/harbour-house/holds")
                .contentType(MediaType.APPLICATION_JSON)
                .content(body))
        .andExpect(status().isConflict())
        .andExpect(jsonPath("$.type").value("urn:innkeep:problem:insufficient-availability"));
  }

  @Test
  void anInvalidGuestEmailIsListedAsAFieldError() throws Exception {
    String body = HOLD_BODY.replace("guest@example.com", "not-an-address");

    mvc.perform(
            post("/api/v1/properties/harbour-house/holds")
                .contentType(MediaType.APPLICATION_JSON)
                .content(body))
        .andExpect(status().isBadRequest())
        .andExpect(jsonPath("$.errors[0].field").value("guest.email"));
  }

  @Test
  void confirmingReturnsTheReservationAtItsLocation() throws Exception {
    String holdId = createHold();

    mvc.perform(post("/api/v1/holds/" + holdId + "/confirm"))
        .andExpect(status().isCreated())
        .andExpect(
            header()
                .string("Location", org.hamcrest.Matchers.startsWith("/api/v1/reservations/IK-")))
        .andExpect(jsonPath("$.status").value("CONFIRMED"))
        .andExpect(jsonPath("$.total").value(200.00));
  }

  @Test
  void confirmingAfterTheTimeLimitIsGone() throws Exception {
    String holdId = createHold();
    clock.advance(Duration.ofMinutes(15));

    mvc.perform(post("/api/v1/holds/" + holdId + "/confirm"))
        .andExpect(status().isGone())
        .andExpect(jsonPath("$.type").value("urn:innkeep:problem:hold-expired"));
  }

  @Test
  void releasingAHoldFreesItsRoomAndShowsTheState() throws Exception {
    String holdId = createHold();

    mvc.perform(post("/api/v1/holds/" + holdId + "/release"))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.status").value("RELEASED"));
    mvc.perform(get("/api/v1/holds/" + holdId)).andExpect(jsonPath("$.status").value("RELEASED"));
    assertThat(held(room, LocalDate.parse("2027-06-01"))).isZero();
  }

  @Test
  void anUnknownHoldIsNotFound() throws Exception {
    mvc.perform(get("/api/v1/holds/00000000-0000-0000-0000-000000000000"))
        .andExpect(status().isNotFound());
  }

  private String createHold() throws Exception {
    MvcResult result =
        mvc.perform(
                post("/api/v1/properties/harbour-house/holds")
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(HOLD_BODY))
            .andExpect(status().isCreated())
            .andReturn();
    String location = result.getResponse().getHeader("Location");
    assertThat(location).isNotNull();
    return location.substring("/api/v1/holds/".length());
  }
}
