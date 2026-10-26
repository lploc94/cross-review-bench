package com.innkeep.booking.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.innkeep.booking.domain.Hold;
import com.innkeep.booking.domain.Property;
import com.innkeep.booking.domain.Reservation;
import com.innkeep.booking.domain.RoomType;
import com.innkeep.booking.support.IntegrationTestBase;
import com.innkeep.booking.support.LogCapture;
import java.time.LocalDate;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MvcResult;

class UnexpectedFailureApiTest extends IntegrationTestBase {

  private static final String HANDLER_LOG = ApiExceptionHandler.class.getName();
  private static final LocalDate JUNE_1 = LocalDate.parse("2027-06-01");
  private static final LocalDate JUNE_2 = LocalDate.parse("2027-06-02");
  private static final LocalDate JUNE_3 = LocalDate.parse("2027-06-03");

  @Test
  void anUnexpectedFailureIsA500ProblemThatDoesNotEchoItsMessage() throws Exception {
    MvcResult result =
        mvc.perform(get("/api/v1/test-only/unexpected-failure"))
            .andExpect(status().isInternalServerError())
            .andExpect(jsonPath("$.type").value("urn:innkeep:problem:internal-error"))
            .andReturn();
    assertThat(result.getResponse().getContentAsString()).doesNotContain("invented-secret");
  }

  @Test
  void anUnexpectedFailureIsLoggedByItsClassOnly() throws Exception {
    String logged =
        LogCapture.during(
            HANDLER_LOG,
            () -> mvc.perform(get("/api/v1/test-only/unexpected-failure")).andReturn());

    assertThat(logged).contains("IllegalStateException").doesNotContain("invented-secret");
  }

  @Test
  void aLockFailureIsA503BusyThatTheCallerMayRetry() throws Exception {
    mvc.perform(get("/api/v1/test-only/lock-failure"))
        .andExpect(status().isServiceUnavailable())
        .andExpect(header().string("Retry-After", "1"))
        .andExpect(jsonPath("$.type").value("urn:innkeep:problem:busy"));
  }

  @Test
  void aDatabaseConstraintFailureIsLoggedWithoutItsSqlDetail() throws Exception {
    String logged =
        LogCapture.during(
            HANDLER_LOG, () -> mvc.perform(get("/api/v1/test-only/integrity-failure")).andReturn());

    assertThat(logged).doesNotContain("IK-SECRET").contains("sqlState=23505");
  }

  @Test
  void aReservationThatIsOutOfStepIsLoggedWithoutItsReference() throws Exception {
    Property property = data.harbourHouse();
    RoomType room = data.roomType(property, "double", 2, "100.00");
    data.rooms(property, room, JUNE_1, JUNE_3, 1);
    Reservation reservation = data.book(property, room, JUNE_1, JUNE_2, 1);
    jdbc.update("update inventory set booked = 0 where room_type_id = ?", room.getId());

    String logged =
        LogCapture.during(
            HANDLER_LOG,
            () ->
                mvc.perform(post("/api/v1/reservations/" + reservation.getReference() + "/cancel"))
                    .andExpect(status().isInternalServerError()));

    assertThat(logged).doesNotContain(reservation.getReference());
  }

  @Test
  void aHoldThatIsOutOfStepIsLoggedWithoutItsId() throws Exception {
    Property property = data.harbourHouse();
    RoomType room = data.roomType(property, "double", 2, "100.00");
    data.rooms(property, room, JUNE_1, JUNE_3, 1);
    Hold hold = data.hold(property, room, JUNE_1, JUNE_2, 1);
    jdbc.update("update inventory set held = 0 where room_type_id = ?", room.getId());

    String logged =
        LogCapture.during(
            HANDLER_LOG,
            () ->
                mvc.perform(
                        post("/api/v1/holds/" + hold.getId() + "/release")
                            .contentType(MediaType.APPLICATION_JSON))
                    .andExpect(status().isInternalServerError()));

    assertThat(logged).doesNotContain(hold.getId().toString());
  }

  @Test
  void aFrameworkErrorKeepsItsOwnStatus() throws Exception {
    mvc.perform(
            post("/api/v1/properties/harbour-house/holds")
                .contentType(MediaType.TEXT_PLAIN)
                .content("not json"))
        .andExpect(status().isUnsupportedMediaType());
  }
}
