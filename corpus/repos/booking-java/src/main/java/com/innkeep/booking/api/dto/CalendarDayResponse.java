package com.innkeep.booking.api.dto;

import com.innkeep.booking.service.CalendarDay;
import java.math.BigDecimal;
import java.time.LocalDate;

/** One night on the guest calendar: rooms free and the price of one room that night. */
public record CalendarDayResponse(
    LocalDate night,
    int available,
    BigDecimal nightlyRate,
    String currency,
    boolean seasonalRate,
    boolean weekendSurcharge) {

  public static CalendarDayResponse from(CalendarDay day) {
    return new CalendarDayResponse(
        day.night(),
        day.available(),
        day.nightlyRate().amount(),
        day.nightlyRate().currency().getCurrencyCode(),
        day.seasonalRate(),
        day.weekendSurcharge());
  }
}
