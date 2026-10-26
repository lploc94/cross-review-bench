package com.innkeep.booking.persistence;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.innkeep.booking.domain.Hold;
import com.innkeep.booking.domain.Property;
import com.innkeep.booking.domain.Reservation;
import com.innkeep.booking.domain.RoomType;
import com.innkeep.booking.support.IntegrationTestBase;
import com.innkeep.booking.support.LogCapture;
import java.time.LocalDate;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.dao.DataIntegrityViolationException;

class SqlErrorLoggingTest extends IntegrationTestBase {

  @Autowired private ReservationRepository reservations;

  @Test
  void aForcedUniqueViolationLeavesNoReferenceInAnyLogLine() throws Exception {
    Property property = data.harbourHouse();
    RoomType room = data.roomType(property, "double", 2, "100.00");
    LocalDate in = LocalDate.parse("2027-06-01");
    LocalDate out = LocalDate.parse("2027-06-02");
    data.rooms(property, room, in, out.plusDays(1), 2);
    Reservation existing = data.book(property, room, in, out, 1);
    Hold other = data.hold(property, room, in, out, 1);

    // Same reference as an existing reservation: the database refuses it with a unique violation.
    String logged =
        LogCapture.during(
            "ROOT",
            () ->
                assertThatThrownBy(
                        () ->
                            reservations.saveAndFlush(
                                new Reservation(existing.getReference(), other, clock.instant())))
                    .isInstanceOf(DataIntegrityViolationException.class));

    assertThat(logged).doesNotContain(existing.getReference());
  }
}
