package com.innkeep.booking.domain;

import java.util.List;

/** A priced stay: the per-night breakdown and the total in the property's currency. */
public record Quote(
    String roomTypeCode,
    DateRange stay,
    int rooms,
    int guests,
    List<PriceLine> lines,
    Money total) {

  public Quote {
    lines = List.copyOf(lines);
  }
}
