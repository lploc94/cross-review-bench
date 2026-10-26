package com.papertrail.workflow.domain;

import java.time.DayOfWeek;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZoneId;
import java.time.ZonedDateTime;

/**
 * Turns a working-time SLA into a due instant. Working time runs Monday to Friday between the start
 * and end times in the calendar's zone. Time outside those hours does not count, a weekend or a
 * finished day rolls to the next working day's start, and a span that crosses midnight continues
 * the next morning. Durations are elapsed time, so a daylight saving change inside a working day
 * makes that day shorter or longer by an hour, as the clocks do.
 */
public final class BusinessCalendar {

  private final ZoneId zone;
  private final LocalTime start;
  private final LocalTime end;

  public BusinessCalendar(ZoneId zone, LocalTime start, LocalTime end) {
    if (zone == null || start == null || end == null) {
      throw new IllegalArgumentException("zone, working start and working end are required");
    }
    if (!end.isAfter(start)) {
      throw new IllegalArgumentException("working end must be after working start");
    }
    this.zone = zone;
    this.start = start;
    this.end = end;
  }

  /** The instant when {@code workingTime} of working hours has passed after {@code from}. */
  public Instant dueAt(Instant from, Duration workingTime) {
    if (workingTime.isNegative() || workingTime.isZero()) {
      throw new IllegalArgumentException("the working-time SLA must be positive");
    }
    long remaining = workingTime.toSeconds();
    ZonedDateTime cursor = nextWorkingMoment(from.atZone(zone));
    while (true) {
      ZonedDateTime close = cursor.toLocalDate().atTime(end).atZone(zone);
      long available = Duration.between(cursor, close).toSeconds();
      if (remaining <= available) {
        return cursor.plusSeconds(remaining).toInstant();
      }
      remaining -= available;
      cursor = nextWorkingMoment(close);
    }
  }

  /** The first moment at or after {@code moment} that falls inside working hours. */
  ZonedDateTime nextWorkingMoment(ZonedDateTime moment) {
    LocalDate day = moment.toLocalDate();
    LocalTime time = moment.toLocalTime();
    if (isWorkingDay(day)) {
      if (time.isBefore(start)) {
        return day.atTime(start).atZone(zone);
      }
      if (time.isBefore(end)) {
        return moment;
      }
    }
    LocalDate next = day.plusDays(1);
    while (!isWorkingDay(next)) {
      next = next.plusDays(1);
    }
    return next.atTime(start).atZone(zone);
  }

  static boolean isWorkingDay(LocalDate day) {
    DayOfWeek dow = day.getDayOfWeek();
    return dow != DayOfWeek.SATURDAY && dow != DayOfWeek.SUNDAY;
  }

  public ZoneId getZone() {
    return zone;
  }

  public LocalTime getStart() {
    return start;
  }

  public LocalTime getEnd() {
    return end;
  }
}
