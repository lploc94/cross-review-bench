package com.innkeep.booking.domain;

/** The request breaks a business rule (for example a stay longer than the configured maximum). */
public class ValidationException extends BookingException {

  public ValidationException(String message) {
    super(message);
  }
}
