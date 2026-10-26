package com.innkeep.booking.domain;

/** The hold's time limit has passed; its rooms are or will be released by the cleanup job. */
public class HoldExpiredException extends BookingException {

  public HoldExpiredException(String holdId) {
    super("hold " + holdId + " has expired");
  }
}
