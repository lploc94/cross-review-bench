package com.innkeep.booking.service;

import com.innkeep.booking.domain.Money;
import java.time.LocalDate;

/**
 * One night of a room type: rooms still free, the nightly price for one room, and why that price is
 * what it is (a seasonal rate applies, or the weekend surcharge does).
 */
public record CalendarDay(
    LocalDate night,
    int available,
    Money nightlyRate,
    boolean seasonalRate,
    boolean weekendSurcharge) {}
