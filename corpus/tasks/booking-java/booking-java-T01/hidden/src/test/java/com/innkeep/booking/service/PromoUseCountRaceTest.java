package com.innkeep.booking.service;

import static org.assertj.core.api.Assertions.assertThat;

import com.innkeep.booking.domain.DateRange;
import com.innkeep.booking.domain.GuestDetails;
import com.innkeep.booking.domain.Hold;
import com.innkeep.booking.domain.Property;
import com.innkeep.booking.domain.Reservation;
import com.innkeep.booking.domain.RoomType;
import com.innkeep.booking.support.IntegrationTestBase;
import java.time.LocalDate;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

/**
 * A cancellation that gives a use back runs while a confirmation that takes one is still open (held
 * inside its charge, after it has taken the use). Whichever commits first, the count must end equal
 * to the reservations that hold a use.
 */
class PromoUseCountRaceTest extends IntegrationTestBase {

  private static final LocalDate FIRST_IN = LocalDate.parse("2027-06-01");
  private static final LocalDate SECOND_IN = LocalDate.parse("2027-06-10");

  @Autowired private HoldService holds;
  @Autowired private ReservationService reservations;
  @Autowired private PromoService promos;

  private final ExecutorService pool = Executors.newFixedThreadPool(2);

  @AfterEach
  void tearDown() {
    pool.shutdownNow();
  }

  @Test
  void aCancellationDuringAConfirmationLeavesTheCountRight() throws Exception {
    Property property = data.harbourHouse();
    RoomType room = data.roomType(property, "double", 2, "100.00");
    data.rooms(property, room, FIRST_IN, SECOND_IN.plusDays(2), 4);
    promos.create(
        property.getCode(),
        new PromoCodeDraft(
            "TWICE", 20, null, LocalDate.parse("2027-04-01"), LocalDate.parse("2027-05-31"), 2));
    Reservation booked = holds.confirm(hold(property, room, FIRST_IN, "Lina Orr").getId());
    Hold pending = hold(property, room, SECOND_IN, "Tomas Reyl");

    var cancelStarted = new CountDownLatch(1);
    var cancelDone = new CountDownLatch(1);
    var cancelling = new AtomicReference<Future<CancellationOutcome>>();
    payments.beforeNextCharge(
        () -> {
          cancelling.set(
              pool.submit(
                  () -> {
                    cancelStarted.countDown();
                    try {
                      return reservations.cancel(booked.getReference());
                    } finally {
                      cancelDone.countDown();
                    }
                  }));
          try {
            cancelStarted.await(30, TimeUnit.SECONDS);
            // Bounded: a cancellation that is not held back by the confirmation finishes at once;
            // one that waits for it stays open until the confirmation commits.
            cancelDone.await(2, TimeUnit.SECONDS);
          } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException(e);
          }
        });

    Reservation confirmed = holds.confirm(pending.getId());
    CancellationOutcome cancelled = cancelling.get().get(60, TimeUnit.SECONDS);

    assertThat(confirmed.getStatus().name()).isEqualTo("CONFIRMED");
    assertThat(cancelled.reservation().getStatus().name()).isEqualTo("CANCELLED");
    assertThat(jdbc.queryForObject("select uses from promo_code", Integer.class)).isEqualTo(1);
  }

  private Hold hold(Property property, RoomType room, LocalDate in, String guest) {
    return holds.create(
        property.getCode(),
        room.getCode(),
        new DateRange(in, in.plusDays(2)),
        1,
        2,
        new GuestDetails(guest, "guest@example.com", null),
        "twice");
  }
}
