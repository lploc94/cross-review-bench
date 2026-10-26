package com.innkeep.booking.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.innkeep.booking.domain.ConflictException;
import com.innkeep.booking.domain.Hold;
import com.innkeep.booking.domain.HoldStatus;
import com.innkeep.booking.domain.InsufficientAvailabilityException;
import com.innkeep.booking.domain.Property;
import com.innkeep.booking.domain.Reservation;
import com.innkeep.booking.domain.RoomType;
import com.innkeep.booking.persistence.InventoryRepository;
import com.innkeep.booking.support.IntegrationTestBase;
import java.time.Duration;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.dao.PessimisticLockingFailureException;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Races for the last room, for the same hold and for the same reservation. Interleavings are forced
 * with latches, never with sleeps, and each test asserts an outcome that holds for every
 * interleaving the database may pick.
 */
class InventoryConcurrencyTest extends IntegrationTestBase {

  private static final LocalDate NIGHT = LocalDate.parse("2027-06-01");
  private static final LocalDate NEXT = LocalDate.parse("2027-06-02");

  @Autowired private HoldService holds;
  @Autowired private ReservationService reservations;
  @Autowired private InventoryRepository inventory;
  @Autowired private PlatformTransactionManager transactions;

  private ExecutorService pool;
  private Property property;
  private RoomType room;

  @BeforeEach
  void setUp() {
    pool = Executors.newFixedThreadPool(8);
    property = data.harbourHouse();
    room = data.roomType(property, "double", 2, "100.00");
  }

  @AfterEach
  void tearDown() {
    pool.shutdownNow();
  }

  @Test
  void aTransactionThatHoldsTheLastRoomBlocksTheOtherUntilItCommits() throws Exception {
    data.rooms(property, room, NIGHT, NEXT, 1);
    var firstHolding = new CountDownLatch(1);
    var secondAttempting = new CountDownLatch(1);
    var template = new TransactionTemplate(transactions);

    Future<Boolean> first =
        pool.submit(
            () ->
                template.execute(
                    status -> {
                      boolean won = inventory.holdRooms(room.getId(), NIGHT, 1) == 1;
                      firstHolding.countDown();
                      await(secondAttempting);
                      return won;
                    }));
    Future<String> second =
        pool.submit(
            () -> {
              await(firstHolding);
              secondAttempting.countDown();
              try {
                data.hold(property, room, NIGHT, NEXT, 1);
                return "held";
              } catch (InsufficientAvailabilityException e) {
                return "sold out";
              }
            });

    assertThat(first.get(30, TimeUnit.SECONDS)).isTrue();
    assertThat(second.get(30, TimeUnit.SECONDS)).isEqualTo("sold out");
    assertThat(held(room, NIGHT)).isEqualTo(1);
  }

  @Test
  void eightRequestsForOneRoomYieldExactlyOneHold() throws Exception {
    data.rooms(property, room, NIGHT, NEXT, 1);
    var start = new CountDownLatch(1);
    List<Future<Boolean>> attempts = new ArrayList<>();
    for (int i = 0; i < 8; i++) {
      attempts.add(
          pool.submit(
              () -> {
                await(start);
                try {
                  data.hold(property, room, NIGHT, NEXT, 1);
                  return true;
                } catch (InsufficientAvailabilityException e) {
                  return false;
                }
              }));
    }
    start.countDown();

    int succeeded = 0;
    for (Future<Boolean> attempt : attempts) {
      if (attempt.get(60, TimeUnit.SECONDS)) {
        succeeded++;
      }
    }

    assertThat(succeeded).isEqualTo(1);
    assertThat(held(room, NIGHT)).isEqualTo(1);
  }

  @Test
  void twoConfirmationsOfOneHoldCreateOneReservationAndOneChargeKey() throws Exception {
    data.rooms(property, room, NIGHT, NEXT, 2);
    Hold hold = data.hold(property, room, NIGHT, NEXT, 1);
    var start = new CountDownLatch(1);
    Future<Reservation> first = pool.submit(() -> confirmAfter(start, hold.getId()));
    Future<Reservation> second = pool.submit(() -> confirmAfter(start, hold.getId()));
    start.countDown();

    List<Object> outcomes = new ArrayList<>();
    for (Future<Reservation> f : List.of(first, second)) {
      try {
        outcomes.add(f.get(60, TimeUnit.SECONDS));
      } catch (java.util.concurrent.ExecutionException e) {
        outcomes.add(e.getCause());
      }
    }

    assertThat(outcomes).filteredOn(o -> o instanceof Reservation).hasSize(1);
    assertThat(outcomes).filteredOn(o -> o instanceof ConflictException).hasSize(1);
    assertThat(booked(room, NIGHT)).isEqualTo(1);
    assertThat(held(room, NIGHT)).isZero();
    assertThat(payments.movements()).allMatch(m -> m.key().equals("charge-" + hold.getId()));
  }

  @Test
  void twoCancellationsOfOneReservationRefundOnce() throws Exception {
    data.rooms(property, room, NIGHT, NEXT, 1);
    Reservation reservation = data.book(property, room, NIGHT, NEXT, 1);
    var start = new CountDownLatch(1);
    List<Future<Object>> attempts = new ArrayList<>();
    for (int i = 0; i < 2; i++) {
      attempts.add(
          pool.submit(
              () -> {
                await(start);
                try {
                  return reservations.cancel(reservation.getReference());
                } catch (ConflictException e) {
                  return e;
                }
              }));
    }
    start.countDown();

    List<Object> outcomes = new ArrayList<>();
    for (Future<Object> attempt : attempts) {
      outcomes.add(attempt.get(60, TimeUnit.SECONDS));
    }

    assertThat(outcomes).filteredOn(o -> o instanceof CancellationOutcome).hasSize(1);
    assertThat(outcomes).filteredOn(o -> o instanceof ConflictException).hasSize(1);
    assertThat(payments.refundCount()).isEqualTo(1);
    assertThat(booked(room, NIGHT)).isZero();
  }

  @Test
  void aReleaseThatArrivesWhileAHoldIsBeingChargedWaitsAndCannotOrphanTheCharge() throws Exception {
    data.rooms(property, room, NIGHT, NEXT, 1);
    Hold hold = data.hold(property, room, NIGHT, NEXT, 1);
    var releaseStarted = new CountDownLatch(1);
    var releaseFinished = new CountDownLatch(1);
    var releasing = new AtomicReference<Future<Hold>>();
    payments.beforeNextCharge(
        () -> {
          releasing.set(
              pool.submit(
                  () -> {
                    releaseStarted.countDown();
                    try {
                      return holds.release(hold.getId());
                    } finally {
                      releaseFinished.countDown();
                    }
                  }));
          await(releaseStarted);
          // A bounded wait, not a sleep: a release that is not held back by the confirmation
          // finishes at once; one that waits for it keeps this open until the charge returns.
          try {
            releaseFinished.await(2, TimeUnit.SECONDS);
          } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException(e);
          }
        });

    Future<Reservation> confirmation = pool.submit(() -> holds.confirm(hold.getId()));

    // The confirmation must succeed: a release cannot take the hold out from under its charge.
    assertThat(confirmation.get(60, TimeUnit.SECONDS).getStatus().name()).isEqualTo("CONFIRMED");
    // The release does not wait for the charge: it gives up at the lock timeout and is told to
    // retry.
    assertThatThrownBy(() -> releasing.get().get(60, TimeUnit.SECONDS))
        .hasCauseInstanceOf(PessimisticLockingFailureException.class);
    assertThat(payments.movements()).hasSize(1);
    assertThat(holds.get(hold.getId()).getStatus().name()).isEqualTo("CONFIRMED");
    assertThat(booked(room, NIGHT)).isEqualTo(1);
    assertThat(held(room, NIGHT)).isZero();
  }

  @Test
  void aReleaseThatCannotGetTheHoldFailsFastInsteadOfWaiting() throws Exception {
    data.rooms(property, room, NIGHT, NEXT, 1);
    Hold hold = data.hold(property, room, NIGHT, NEXT, 1);
    var released = new CountDownLatch(1);
    Future<?> locker = lockTheHoldUntil(released, hold.getId());

    Future<Hold> release = pool.submit(() -> holds.release(hold.getId()));
    try {
      assertThatThrownBy(() -> release.get(10, TimeUnit.SECONDS))
          .isInstanceOf(java.util.concurrent.ExecutionException.class)
          .hasCauseInstanceOf(PessimisticLockingFailureException.class);
    } finally {
      released.countDown();
      locker.get(30, TimeUnit.SECONDS);
    }
    assertThat(holds.get(hold.getId()).getStatus()).isEqualTo(HoldStatus.ACTIVE);
  }

  @Test
  void aSweepSkipsAHoldItCannotLockAndExpiresItOnTheNextRun() throws Exception {
    data.rooms(property, room, NIGHT, NEXT, 1);
    Hold hold = data.hold(property, room, NIGHT, NEXT, 1);
    clock.advance(Duration.ofMinutes(16));
    var released = new CountDownLatch(1);
    Future<?> locker = lockTheHoldUntil(released, hold.getId());

    Future<Integer> sweep = pool.submit(() -> holds.releaseExpired(10));
    try {
      assertThat(sweep.get(10, TimeUnit.SECONDS)).isZero();
    } finally {
      released.countDown();
      locker.get(30, TimeUnit.SECONDS);
    }

    assertThat(holds.releaseExpired(10)).isEqualTo(1);
    assertThat(holds.get(hold.getId()).getStatus()).isEqualTo(HoldStatus.EXPIRED);
  }

  @Test
  void aSweepPagesPastHoldsItCannotLockToTheDueOnesBehindThem() throws Exception {
    data.rooms(property, room, NIGHT, NEXT, 3);
    Hold a = data.hold(property, room, NIGHT, NEXT, 1);
    Hold b = data.hold(property, room, NIGHT, NEXT, 1);
    clock.advance(Duration.ofMinutes(1));
    Hold c = data.hold(property, room, NIGHT, NEXT, 1);
    // a and b fell due first, c a minute later; the batch size is 2, so the first page is a and b.
    clock.advance(Duration.ofMinutes(16));
    var released = new CountDownLatch(1);
    Future<?> locker = lockTheHoldUntil(released, a.getId(), b.getId());

    Future<Integer> sweep = pool.submit(() -> holds.releaseExpired(2));
    try {
      assertThat(sweep.get(10, TimeUnit.SECONDS)).isEqualTo(1);
    } finally {
      released.countDown();
      locker.get(30, TimeUnit.SECONDS);
    }

    assertThat(holds.get(c.getId()).getStatus()).isEqualTo(HoldStatus.EXPIRED);
    assertThat(holds.get(a.getId()).getStatus()).isEqualTo(HoldStatus.ACTIVE);
    assertThat(holds.releaseExpired(10)).isEqualTo(2);
  }

  /** Holds the hold's row lock in its own transaction until the latch counts down. */
  private Future<?> lockTheHoldUntil(CountDownLatch released, UUID... holdIds) {
    var template = new TransactionTemplate(transactions);
    var locked = new CountDownLatch(1);
    Future<?> locker =
        pool.submit(
            () ->
                template.execute(
                    status -> {
                      for (UUID holdId : holdIds) {
                        jdbc.queryForObject(
                            "select id from hold where id = ? for update", UUID.class, holdId);
                      }
                      locked.countDown();
                      await(released);
                      return null;
                    }));
    await(locked);
    return locker;
  }

  private Reservation confirmAfter(CountDownLatch start, java.util.UUID holdId)
      throws InterruptedException {
    start.await();
    return holds.confirm(holdId);
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
