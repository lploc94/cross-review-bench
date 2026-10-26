package com.innkeep.booking.api;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.innkeep.booking.domain.Hold;
import com.innkeep.booking.domain.Property;
import com.innkeep.booking.domain.Reservation;
import com.innkeep.booking.domain.RoomType;
import com.innkeep.booking.support.IntegrationTestBase;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class OperationsApiTest extends IntegrationTestBase {

  private static final String ADMIN = "/api/v1/admin";
  private static final String HARBOUR = "/api/v1/properties/harbour-house";

  private Property property;
  private RoomType room;
  private Reservation stay;

  @BeforeEach
  void setUp() {
    property = data.harbourHouse();
    room = data.roomType(property, "double", 2, "100.00");
    data.rooms(property, room, LocalDate.parse("2027-06-10"), LocalDate.parse("2027-06-21"), 2);
    stay =
        data.book(property, room, LocalDate.parse("2027-06-10"), LocalDate.parse("2027-06-12"), 1);
  }

  @Test
  void theLedgerShowsTheChargeAndThenTheRefund() throws Exception {
    mvc.perform(
            get(ADMIN + "/reservations/" + stay.getReference() + "/ledger")
                .header("Authorization", ADMIN_AUTH))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.currency").value("EUR"))
        .andExpect(jsonPath("$.entries.length()").value(1))
        .andExpect(jsonPath("$.entries[0].kind").value("CHARGE"))
        .andExpect(jsonPath("$.entries[0].amount").value(210.00));

    clock.set(Instant.parse("2027-06-01T10:00:00Z"));
    mvc.perform(post("/api/v1/reservations/" + stay.getReference() + "/cancel"))
        .andExpect(status().isOk());

    mvc.perform(
            get(ADMIN + "/reservations/" + stay.getReference() + "/ledger")
                .header("Authorization", ADMIN_AUTH))
        .andExpect(jsonPath("$.entries.length()").value(2))
        .andExpect(jsonPath("$.entries[1].kind").value("REFUND"))
        .andExpect(jsonPath("$.entries[1].amount").value(210.00));
  }

  @Test
  void aCancellationQuoteShowsTheRefundAndChangesNothing() throws Exception {
    clock.set(Instant.parse("2027-06-01T10:00:00Z"));
    mvc.perform(get("/api/v1/reservations/" + stay.getReference() + "/cancellation-quote"))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.refundPercent").value(100))
        .andExpect(jsonPath("$.refundAmount").value(210.00));

    mvc.perform(get("/api/v1/reservations/" + stay.getReference()))
        .andExpect(jsonPath("$.status").value("CONFIRMED"));
  }

  @Test
  void aQuoteAtALaterInstantAfterCheckInRefundsNothing() throws Exception {
    mvc.perform(
            get("/api/v1/reservations/" + stay.getReference() + "/cancellation-quote")
                .param("at", "2027-06-11T10:00:00Z"))
        .andExpect(jsonPath("$.refundPercent").value(0))
        .andExpect(jsonPath("$.refundAmount").value(0.00));
  }

  @Test
  void aQuoteForACancelledReservationIsAConflict() throws Exception {
    clock.set(Instant.parse("2027-06-01T10:00:00Z"));
    mvc.perform(post("/api/v1/reservations/" + stay.getReference() + "/cancel"))
        .andExpect(status().isOk());
    mvc.perform(get("/api/v1/reservations/" + stay.getReference() + "/cancellation-quote"))
        .andExpect(status().isConflict());
  }

  @Test
  void theReservationListFiltersByPropertyAndGuestName() throws Exception {
    mvc.perform(
            get(ADMIN + "/reservations")
                .header("Authorization", ADMIN_AUTH)
                .param("property", "harbour-house"))
        .andExpect(jsonPath("$.totalItems").value(1));
    mvc.perform(
            get(ADMIN + "/reservations")
                .header("Authorization", ADMIN_AUTH)
                .param("property", "elsewhere"))
        .andExpect(jsonPath("$.totalItems").value(0));
    mvc.perform(
            get(ADMIN + "/reservations")
                .header("Authorization", ADMIN_AUTH)
                .param("guestName", "  MARA "))
        .andExpect(jsonPath("$.totalItems").value(1));
    mvc.perform(
            get(ADMIN + "/reservations")
                .header("Authorization", ADMIN_AUTH)
                .param("guestName", "quill%"))
        .andExpect(jsonPath("$.totalItems").value(1));
    mvc.perform(
            get(ADMIN + "/reservations")
                .header("Authorization", ADMIN_AUTH)
                .param("guestName", "nobody"))
        .andExpect(jsonPath("$.totalItems").value(0));
  }

  @Test
  void theAdminSummaryCountsEveryStatus() throws Exception {
    mvc.perform(get(ADMIN + "/reservations/summary").header("Authorization", ADMIN_AUTH))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.CONFIRMED").value(1))
        .andExpect(jsonPath("$.CANCELLED").value(0))
        .andExpect(jsonPath("$.COMPLETED").value(0));
  }

  @Test
  void theHoldListFiltersAndAnActiveHoldCanBeExpiredByHand() throws Exception {
    Hold hold =
        data.hold(property, room, LocalDate.parse("2027-06-20"), LocalDate.parse("2027-06-21"), 1);

    mvc.perform(get(ADMIN + "/holds").header("Authorization", ADMIN_AUTH))
        .andExpect(jsonPath("$.totalItems").value(1))
        .andExpect(jsonPath("$.items[0].status").value("ACTIVE"));
    mvc.perform(
            get(ADMIN + "/holds")
                .header("Authorization", ADMIN_AUTH)
                .param("property", "elsewhere"))
        .andExpect(jsonPath("$.totalItems").value(0));

    mvc.perform(
            post(ADMIN + "/holds/" + hold.getId() + "/expire").header("Authorization", ADMIN_AUTH))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.status").value("EXPIRED"));
    mvc.perform(
            post(ADMIN + "/holds/" + hold.getId() + "/expire").header("Authorization", ADMIN_AUTH))
        .andExpect(status().isConflict());

    mvc.perform(get(ADMIN + "/holds/summary").header("Authorization", ADMIN_AUTH))
        .andExpect(jsonPath("$.ACTIVE").value(0))
        .andExpect(jsonPath("$.EXPIRED").value(1));
  }

  @Test
  void theMaintenanceRunReportsWhatItChanged() throws Exception {
    data.hold(property, room, LocalDate.parse("2027-06-20"), LocalDate.parse("2027-06-21"), 1);
    clock.advance(Duration.ofMinutes(16));

    mvc.perform(post(ADMIN + "/maintenance/run").header("Authorization", ADMIN_AUTH))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.releasedHolds").value(1))
        .andExpect(jsonPath("$.completedStays").value(0));
  }

  @Test
  void arrivalsInHouseAndDeparturesFollowTheStayThroughCheckIn() throws Exception {
    String arrivals = ADMIN + "/properties/harbour-house/arrivals";
    String departures = ADMIN + "/properties/harbour-house/departures";
    String inHouse = ADMIN + "/properties/harbour-house/in-house";

    mvc.perform(get(arrivals).header("Authorization", ADMIN_AUTH).param("date", "2027-06-10"))
        .andExpect(jsonPath("$.length()").value(1))
        .andExpect(jsonPath("$[0].reference").value(stay.getReference()));

    clock.set(Instant.parse("2027-06-10T14:00:00Z"));
    mvc.perform(
            post(ADMIN + "/reservations/" + stay.getReference() + "/check-in")
                .header("Authorization", ADMIN_AUTH))
        .andExpect(status().isOk());

    mvc.perform(get(arrivals).header("Authorization", ADMIN_AUTH).param("date", "2027-06-10"))
        .andExpect(jsonPath("$.length()").value(0));
    mvc.perform(get(inHouse).header("Authorization", ADMIN_AUTH).param("date", "2027-06-11"))
        .andExpect(jsonPath("$.length()").value(1));
    mvc.perform(get(inHouse).header("Authorization", ADMIN_AUTH).param("date", "2027-06-12"))
        .andExpect(jsonPath("$.length()").value(0));
    mvc.perform(get(departures).header("Authorization", ADMIN_AUTH).param("date", "2027-06-12"))
        .andExpect(jsonPath("$.length()").value(1));
  }

  @Test
  void netRevenueCountsChargesAndRefundsByThePropertyDay() throws Exception {
    String revenue = ADMIN + "/properties/harbour-house/revenue";

    mvc.perform(
            get(revenue)
                .header("Authorization", ADMIN_AUTH)
                .param("from", "2027-05-01")
                .param("to", "2027-05-02"))
        .andExpect(jsonPath("$.charged").value(210.00))
        .andExpect(jsonPath("$.refunded").value(0.00))
        .andExpect(jsonPath("$.net").value(210.00));

    mvc.perform(
            get(revenue)
                .header("Authorization", ADMIN_AUTH)
                .param("from", "2027-05-02")
                .param("to", "2027-05-03"))
        .andExpect(jsonPath("$.charged").value(0.00));

    clock.set(Instant.parse("2027-06-01T10:00:00Z"));
    mvc.perform(post("/api/v1/reservations/" + stay.getReference() + "/cancel"))
        .andExpect(status().isOk());

    mvc.perform(
            get(revenue)
                .header("Authorization", ADMIN_AUTH)
                .param("from", "2027-06-01")
                .param("to", "2027-06-02"))
        .andExpect(jsonPath("$.refunded").value(210.00))
        .andExpect(jsonPath("$.net").value(-210.00));
  }

  @Test
  void theGuestListAndCheckInAreNoLongerPublic() throws Exception {
    mvc.perform(get("/api/v1/reservations")).andExpect(status().isNotFound());
    mvc.perform(post("/api/v1/reservations/" + stay.getReference() + "/check-in"))
        .andExpect(status().isNotFound());
    mvc.perform(get(ADMIN + "/reservations")).andExpect(status().isUnauthorized());
  }

  @Test
  void theOperationalViewsRequireTheAdminToken() throws Exception {
    mvc.perform(get(ADMIN + "/holds")).andExpect(status().isUnauthorized());
    mvc.perform(post(ADMIN + "/maintenance/run")).andExpect(status().isUnauthorized());
  }
}
