package com.innkeep.booking.service;

import static org.assertj.core.api.Assertions.assertThat;

import com.innkeep.booking.domain.Hold;
import com.innkeep.booking.domain.HoldStatus;
import com.innkeep.booking.domain.Property;
import com.innkeep.booking.domain.RoomType;
import com.innkeep.booking.support.IntegrationTestBase;
import java.time.LocalDate;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

/**
 * While a confirmation is paused in its charge it holds its hold row and nothing else. Other
 * guests' work on the same property and room type goes ahead; the charge is only ever waited on by
 * the confirmation itself. Probes run on their own threads and connections, with bounded waits.
 */
class ConfirmationLockScopeTest extends IntegrationTestBase {

  private static final LocalDate NIGHT = LocalDate.parse("2027-06-01");
  private static final LocalDate NEXT = LocalDate.parse("2027-06-02");

  @Autowired private HoldService holds;

  private ExecutorService pool;
  private Property property;
  private RoomType room;

  @BeforeEach
  void setUp() {
    pool = Executors.newFixedThreadPool(4);
    property = data.harbourHouse();
    room = data.roomType(property, "double", 2, "100.00");
    data.rooms(property, room, NIGHT, NEXT, 3);
  }

  @AfterEach
  void tearDown() {
    pool.shutdownNow();
  }

  @Test
  void aConfirmationLocksOnlyTheHoldRowWhileItIsCharged() throws Exception {
    Hold hold = data.hold(property, room, NIGHT, NEXT, 1);
    var probeFailure = new AtomicReference<Throwable>();
    payments.beforeNextCharge(
        () ->
            probeFailure.set(
                outcome(
                    pool.submit(
                        () -> {
                          // NOWAIT: fails at once if another transaction holds either row.
                          jdbc.queryForObject(
                              "select id from property where id = ? for update nowait",
                              Long.class,
                              property.getId());
                          jdbc.queryForObject(
                              "select id from room_type where id = ? for update nowait",
                              Long.class,
                              room.getId());
                          return null;
                        }))));

    holds.confirm(hold.getId());

    assertThat(probeFailure.get()).isNull();
  }

  @Test
  void aNewHoldOnTheSameRoomTypeIsMadeWhileAConfirmationIsCharging() throws Exception {
    Hold first = data.hold(property, room, NIGHT, NEXT, 1);
    var createdWhilePaused = new AtomicReference<Boolean>();
    payments.beforeNextCharge(
        () ->
            createdWhilePaused.set(
                finishes(pool.submit(() -> data.hold(property, room, NIGHT, NEXT, 1)))));

    holds.confirm(first.getId());

    assertThat(createdWhilePaused.get()).isTrue();
  }

  @Test
  void aReleaseOfAnotherHoldOfTheSamePropertyGoesThroughWhileAConfirmationIsCharging()
      throws Exception {
    Hold first = data.hold(property, room, NIGHT, NEXT, 1);
    Hold other = data.hold(property, room, NIGHT, NEXT, 1);
    var releasedWhilePaused = new AtomicReference<Boolean>();
    payments.beforeNextCharge(
        () -> releasedWhilePaused.set(finishes(pool.submit(() -> holds.release(other.getId())))));

    holds.confirm(first.getId());

    assertThat(releasedWhilePaused.get()).isTrue();
    assertThat(holds.get(other.getId()).getStatus()).isEqualTo(HoldStatus.RELEASED);
  }

  /** The probe's failure, or null when it finished within the bound. */
  private static Throwable outcome(Future<?> probe) {
    try {
      probe.get(10, TimeUnit.SECONDS);
      return null;
    } catch (ExecutionException e) {
      return e.getCause();
    } catch (TimeoutException e) {
      return e;
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      throw new IllegalStateException(e);
    }
  }

  /** Whether the work finished within the bound and without an error. */
  private static boolean finishes(Future<?> work) {
    return outcome(work) == null;
  }
}
