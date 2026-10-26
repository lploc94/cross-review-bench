package com.papertrail.workflow.domain;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Duration;
import java.time.Instant;
import java.time.LocalTime;
import java.time.ZoneId;
import org.junit.jupiter.api.Test;

/** Working-hours arithmetic in London: BST (UTC+1) from 28 March 2027, GMT before it. */
class BusinessCalendarTest {

  private static final BusinessCalendar LONDON =
      new BusinessCalendar(ZoneId.of("Europe/London"), LocalTime.of(9, 0), LocalTime.of(17, 0));

  private static Instant utc(String text) {
    return Instant.parse(text);
  }

  @Test
  void aSpanInsideOneWorkingDayEndsWhenItElapses() {
    // Monday 10:00 BST
    Instant due = LONDON.dueAt(utc("2027-05-03T09:00:00Z"), Duration.ofHours(2));

    assertThat(due).isEqualTo(utc("2027-05-03T11:00:00Z")); // 12:00 BST
  }

  @Test
  void aStartBeforeOpeningCountsFromOpening() {
    // Monday 07:30 BST
    Instant due = LONDON.dueAt(utc("2027-05-03T06:30:00Z"), Duration.ofMinutes(60));

    assertThat(due).isEqualTo(utc("2027-05-03T09:00:00Z")); // 10:00 BST
  }

  @Test
  void theTimeAfterClosingRollsToTheNextMorning() {
    // Monday 18:00 BST: nothing of the working day is left
    Instant due = LONDON.dueAt(utc("2027-05-03T17:00:00Z"), Duration.ofMinutes(30));

    assertThat(due).isEqualTo(utc("2027-05-04T08:30:00Z")); // Tuesday 09:30 BST
  }

  @Test
  void aStartExactlyAtClosingCountsFromTheNextWorkingMorning() {
    // Monday 17:00 BST
    Instant due = LONDON.dueAt(utc("2027-05-03T16:00:00Z"), Duration.ofMinutes(60));

    assertThat(due).isEqualTo(utc("2027-05-04T09:00:00Z")); // Tuesday 10:00 BST
  }

  @Test
  void aFridayRemainderContinuesOnMonday() {
    // Friday 16:30 BST, one hour of work: 30 minutes on Friday, 30 on Monday
    Instant due = LONDON.dueAt(utc("2027-05-07T15:30:00Z"), Duration.ofHours(1));

    assertThat(due).isEqualTo(utc("2027-05-10T08:30:00Z")); // Monday 09:30 BST
  }

  @Test
  void aWeekendStartWaitsForMondayOpening() {
    // Saturday 12:00 BST
    Instant due = LONDON.dueAt(utc("2027-05-08T11:00:00Z"), Duration.ofMinutes(60));

    assertThat(due).isEqualTo(utc("2027-05-10T09:00:00Z")); // Monday 10:00 BST
  }

  @Test
  void aSpanLongerThanOneDayCrossesTheWeekend() {
    // Thursday 16:00 BST plus ten working hours: 1 on Thursday, 8 on Friday, 1 on Monday
    Instant due = LONDON.dueAt(utc("2027-05-06T15:00:00Z"), Duration.ofHours(10));

    assertThat(due).isEqualTo(utc("2027-05-10T09:00:00Z")); // Monday 10:00 BST
  }

  @Test
  void aSpanAcrossTheClockChangeKeepsElapsedTime() {
    // Friday 26 March 2027 16:00 GMT, two hours: one on Friday, one on Monday 29 March (BST)
    Instant due = LONDON.dueAt(utc("2027-03-26T16:00:00Z"), Duration.ofHours(2));

    assertThat(due).isEqualTo(utc("2027-03-29T09:00:00Z")); // Monday 10:00 BST
  }

  @Test
  void aStartOnTheClockChangeMondayWaitsForOpeningInSummerTime() {
    // Monday 29 March 2027 08:30 BST (07:30 UTC), 60 minutes
    Instant due = LONDON.dueAt(utc("2027-03-29T07:30:00Z"), Duration.ofMinutes(60));

    assertThat(due).isEqualTo(utc("2027-03-29T09:00:00Z")); // 10:00 BST
  }

  @Test
  void nonPositiveWorkingTimeIsRejected() {
    assertThatThrownBy(() -> LONDON.dueAt(utc("2027-05-03T09:00:00Z"), Duration.ZERO))
        .isInstanceOf(IllegalArgumentException.class);
  }

  @Test
  void theWorkingEndMustBeAfterTheStart() {
    assertThatThrownBy(
            () ->
                new BusinessCalendar(
                    ZoneId.of("Europe/London"), LocalTime.of(17, 0), LocalTime.of(9, 0)))
        .isInstanceOf(IllegalArgumentException.class);
  }
}
