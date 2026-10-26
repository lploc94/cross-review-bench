package com.innkeep.booking.api;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.innkeep.booking.domain.Reservation;
import com.innkeep.booking.support.IntegrationTestBase;
import java.time.Instant;
import java.time.LocalDate;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class ReservationApiTest extends IntegrationTestBase {

  private Reservation reservation;

  @BeforeEach
  void setUp() {
    var property = data.harbourHouse();
    var room = data.roomType(property, "double", 2, "100.00");
    LocalDate in = LocalDate.parse("2027-06-10");
    data.rooms(property, room, in, LocalDate.parse("2027-06-12"), 2);
    reservation = data.book(property, room, in, LocalDate.parse("2027-06-12"), 1);
  }

  @Test
  void theListIsPaged() throws Exception {
    mvc.perform(
            get("/api/v1/admin/reservations")
                .header("Authorization", ADMIN_AUTH)
                .param("size", "10"))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.totalItems").value(1))
        .andExpect(jsonPath("$.items[0].reference").value(reservation.getReference()))
        .andExpect(jsonPath("$.items[0].lines").doesNotExist());
  }

  @Test
  void aPageSizeAboveTheMaximumIsRefused() throws Exception {
    mvc.perform(
            get("/api/v1/admin/reservations")
                .header("Authorization", ADMIN_AUTH)
                .param("size", "500"))
        .andExpect(status().isBadRequest());
  }

  @Test
  void aReservationIsReadWithItsPriceLines() throws Exception {
    mvc.perform(get("/api/v1/reservations/" + reservation.getReference()))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.total").value(210.00))
        .andExpect(jsonPath("$.lines.length()").value(2));
  }

  @Test
  void anUnknownReferenceIsNotFound() throws Exception {
    mvc.perform(get("/api/v1/reservations/IK-NOPE0000"))
        .andExpect(status().isNotFound())
        .andExpect(jsonPath("$.type").value("urn:innkeep:problem:not-found"));
  }

  @Test
  void cancellingRefundsAndASecondCancelIsAConflict() throws Exception {
    clock.set(Instant.parse("2027-06-01T10:00:00Z"));
    String url = "/api/v1/reservations/" + reservation.getReference() + "/cancel";

    mvc.perform(post(url))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.refundAmount").value(210.00))
        .andExpect(jsonPath("$.reservation.status").value("CANCELLED"));
    mvc.perform(post(url))
        .andExpect(status().isConflict())
        .andExpect(jsonPath("$.type").value("urn:innkeep:problem:conflict"));
  }

  @Test
  void checkInIsRefusedBeforeTheCheckInDate() throws Exception {
    clock.set(Instant.parse("2027-06-09T10:00:00Z"));

    mvc.perform(
            post("/api/v1/admin/reservations/" + reservation.getReference() + "/check-in")
                .header("Authorization", ADMIN_AUTH))
        .andExpect(status().isConflict());
  }

  @Test
  void checkInOnTheCheckInDateMovesTheStay() throws Exception {
    clock.set(Instant.parse("2027-06-10T14:00:00Z"));

    mvc.perform(
            post("/api/v1/admin/reservations/" + reservation.getReference() + "/check-in")
                .header("Authorization", ADMIN_AUTH))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.status").value("CHECKED_IN"));
  }
}
