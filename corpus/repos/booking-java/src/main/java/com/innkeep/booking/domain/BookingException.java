package com.innkeep.booking.domain;

/** Root of the service's own errors. The API layer maps each subtype to an HTTP status. */
public abstract class BookingException extends RuntimeException {

  protected BookingException(String message) {
    super(message);
  }
}
