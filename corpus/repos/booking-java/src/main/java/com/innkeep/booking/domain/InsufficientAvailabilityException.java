package com.innkeep.booking.domain;

import java.time.LocalDate;

public class InsufficientAvailabilityException extends ConflictException {

  public InsufficientAvailabilityException(String roomTypeCode, LocalDate night) {
    super("not enough " + roomTypeCode + " rooms left on " + night);
  }
}
