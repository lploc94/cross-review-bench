package com.innkeep.booking.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.innkeep.booking.domain.DateRange;
import com.innkeep.booking.domain.GuestDetails;
import com.innkeep.booking.domain.Hold;
import com.innkeep.booking.domain.InsufficientAvailabilityException;
import com.innkeep.booking.domain.Property;
import com.innkeep.booking.domain.RoomType;
import com.innkeep.booking.service.HoldService.GroupItem;
import com.innkeep.booking.support.IntegrationTestBase;
import java.sql.Date;
import java.time.LocalDate;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.LockSupport;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

class GroupHoldOrderCheckTest extends IntegrationTestBase {

  private static final LocalDate JUNE_1 = LocalDate.parse("2027-06-01");
  private static final LocalDate JUNE_2 = LocalDate.parse("2027-06-02");
  private static final LocalDate JUNE_3 = LocalDate.parse("2027-06-03");
  private static final DateRange STAY = new DateRange(JUNE_1, JUNE_3);
  private static final GuestDetails GUEST =
      new GuestDetails("Ilse Varno", "ilse@example.com", null);

  @Autowired private HoldService holds;
  @Autowired private PlatformTransactionManager transactions;

  private ExecutorService pool;
  private Property property;
  private RoomType first;
  private RoomType second;

  @BeforeEach
  void setUp() {
    pool = Executors.newFixedThreadPool(4);
    property = data.harbourHouse();
    first = data.roomType(property, "double", 2, "100.00");
    second = data.roomType(property, "suite", 2, "200.00");
    data.rooms(property, first, JUNE_1, JUNE_3, 2);
    data.rooms(property, second, JUNE_1, JUNE_3, 2);
  }

  @AfterEach
  void tearDown() {
    pool.shutdownNow();
  }

  private List<Hold> group(String a, String b) {
    return holds.createGroup(
        property.getCode(), STAY, List.of(new GroupItem(a, 1, 2), new GroupItem(b, 1, 2)), GUEST);
  }

  @Test
  void whenTheSecondRoomTypeIsShortNothingIsTakenForTheFirst() {
    data.hold(property, second, JUNE_2, JUNE_3, 2);
    int holdsBefore = jdbc.queryForObject("select count(*) from hold", Integer.class);

    assertThatThrownBy(() -> group("double", "suite"))
        .isInstanceOf(InsufficientAvailabilityException.class);

    assertThat(held(first, JUNE_1)).isZero();
    assertThat(held(first, JUNE_2)).isZero();
    assertThat(held(second, JUNE_1)).isZero();
    assertThat(held(second, JUNE_2)).isEqualTo(2);
    assertThat(jdbc.queryForObject("select count(*) from hold", Integer.class))
        .isEqualTo(holdsBefore);
  }

  @Test
  void twoGroupsListingTheirRoomTypesInOppositeOrderBothComplete() throws Exception {
    var released = new CountDownLatch(1);
    var locked = new CountDownLatch(1);
    var template = new TransactionTemplate(transactions);
    Future<?> blocker =
        pool.submit(
            () ->
                template.execute(
                    status -> {
                      jdbc.queryForList(
                          "select id from inventory where room_type_id = ? and night = ?"
                              + " for update",
                          first.getId(),
                          Date.valueOf(JUNE_1));
                      locked.countDown();
                      await(released);
                      return null;
                    }));
    await(locked);

    Future<List<Hold>> forward = pool.submit(() -> group("double", "suite"));
    waitForLockWaiters(1);
    Future<List<Hold>> backward = pool.submit(() -> group("suite", "double"));
    waitForLockWaiters(2);
    released.countDown();
    blocker.get(30, TimeUnit.SECONDS);

    assertThat(forward.get(30, TimeUnit.SECONDS)).hasSize(2);
    assertThat(backward.get(30, TimeUnit.SECONDS)).hasSize(2);
    assertThat(held(first, JUNE_1)).isEqualTo(2);
    assertThat(held(second, JUNE_2)).isEqualTo(2);
  }

  /** Waits until this many sessions of the test database are waiting for a row lock. */
  private void waitForLockWaiters(int count) {
    long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
    while (jdbc.queryForObject(
            "select count(*) from pg_stat_activity"
                + " where datname = current_database() and wait_event_type = 'Lock'",
            Integer.class)
        < count) {
      if (System.nanoTime() > deadline) {
        throw new IllegalStateException("no session waited for the lock");
      }
      LockSupport.parkNanos(TimeUnit.MILLISECONDS.toNanos(5));
    }
  }

  private static void await(CountDownLatch latch) {
    try {
      if (!latch.await(30, TimeUnit.SECONDS)) {
        throw new IllegalStateException("latch timed out");
      }
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      throw new IllegalStateException(e);
    }
  }
}
