package com.innkeep.booking.domain;

public class NotFoundException extends BookingException {

  public NotFoundException(String what, Object key) {
    super(what + " " + key + " was not found");
  }
}
