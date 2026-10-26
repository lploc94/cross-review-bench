package com.innkeep.booking.domain;

/** The payment gateway refused or could not process a charge or refund. */
public class PaymentFailedException extends BookingException {

  public PaymentFailedException(String message, Throwable cause) {
    super(message);
    initCause(cause);
  }
}
