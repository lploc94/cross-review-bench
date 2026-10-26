package com.innkeep.booking.domain;

/** The request is valid but the current state of the data does not allow it. */
public class ConflictException extends BookingException {

  public ConflictException(String message) {
    super(message);
  }
}
