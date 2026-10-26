package com.innkeep.booking.support;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;

/**
 * A clock tests move by hand: hold expiry, cancellation deadlines and cleanup never race real time.
 */
public final class MutableClock extends Clock {

  private final ZoneId zone;
  private Instant now;

  public MutableClock(Instant start) {
    this(start, ZoneOffset.UTC);
  }

  private MutableClock(Instant start, ZoneId zone) {
    this.now = start;
    this.zone = zone;
  }

  public synchronized void set(Instant instant) {
    this.now = instant;
  }

  public synchronized void advance(Duration duration) {
    this.now = now.plus(duration);
  }

  @Override
  public ZoneId getZone() {
    return zone;
  }

  @Override
  public Clock withZone(ZoneId newZone) {
    return new MutableClock(instant(), newZone);
  }

  @Override
  public synchronized Instant instant() {
    return now;
  }
}
