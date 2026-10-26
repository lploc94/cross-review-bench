package com.innkeep.booking.persistence;

import static org.assertj.core.api.Assertions.assertThat;

import com.innkeep.booking.domain.Property;
import com.innkeep.booking.domain.RoomType;
import com.innkeep.booking.service.ReservationService;
import com.innkeep.booking.support.IntegrationTestBase;
import jakarta.persistence.EntityManagerFactory;
import java.time.LocalDate;
import java.util.stream.IntStream;
import org.hibernate.SessionFactory;
import org.hibernate.stat.Statistics;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.domain.PageRequest;

/**
 * The reservation list must not issue a statement per row: property and room type are fetched in
 * the list query itself. The count is compared across list sizes, not against a fixed number.
 */
class ReservationListQueryTest extends IntegrationTestBase {

  @Autowired private ReservationService reservations;
  @Autowired private EntityManagerFactory entityManagerFactory;

  private Property property;
  private RoomType room;
  private int nextDay;

  @BeforeEach
  void setUp() {
    property = data.harbourHouse();
    room = data.roomType(property, "double", 2, "100.00");
    data.rooms(property, room, LocalDate.parse("2027-06-01"), LocalDate.parse("2027-07-01"), 20);
    nextDay = 1;
  }

  @Test
  void listingCostsTheSameStatementsWhateverTheNumberOfRows() {
    bookMore(3);
    long smallList = statementsForListing();

    bookMore(9);
    long largeList = statementsForListing();

    assertThat(smallList).isLessThanOrEqualTo(2);
    assertThat(largeList).isEqualTo(smallList);
  }

  @Test
  void theListCarriesPropertyAndRoomTypeCodes() {
    bookMore(2);

    var page = reservations.search(null, null, null, null, null, null, PageRequest.of(0, 20));

    assertThat(page.getContent())
        .allSatisfy(
            reservation -> {
              assertThat(reservation.getProperty().getCode()).isEqualTo("harbour-house");
              assertThat(reservation.getRoomType().getCode()).isEqualTo("double");
            });
    assertThat(page.getTotalElements()).isEqualTo(2);
  }

  @Test
  void pagesFollowTheCheckInOrder() {
    bookMore(5);

    var first = reservations.search(null, null, null, null, null, null, PageRequest.of(0, 2));
    var second = reservations.search(null, null, null, null, null, null, PageRequest.of(1, 2));

    assertThat(first.getTotalPages()).isEqualTo(3);
    assertThat(second.getContent().get(0).getCheckIn())
        .isAfterOrEqualTo(first.getContent().get(1).getCheckIn());
  }

  private long statementsForListing() {
    Statistics statistics = entityManagerFactory.unwrap(SessionFactory.class).getStatistics();
    statistics.clear();
    reservations.search(null, null, null, null, null, null, PageRequest.of(0, 50));
    return statistics.getPrepareStatementCount();
  }

  private void bookMore(int count) {
    IntStream.range(0, count)
        .forEach(
            i -> {
              LocalDate in = LocalDate.parse("2027-06-01").plusDays(nextDay++);
              data.book(property, room, in, in.plusDays(1), 1);
            });
  }
}
