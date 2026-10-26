package com.innkeep.booking.domain;

import java.time.DayOfWeek;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Optional;

/**
 * Prices a stay. The rules run in this fixed order and the order is part of the contract:
 *
 * <ol>
 *   <li>the nightly rate: the seasonal rate covering the night, else the base rate;
 *   <li>the weekend surcharge on Friday and Saturday nights, by the property's local night date;
 *   <li>the length-of-stay discount on the room charges, when the stay is long enough;
 *   <li>the extra-guest fee per night for guests above the rooms' capacity (never discounted).
 * </ol>
 *
 * Every amount is rounded to the currency's minor units with HALF_EVEN as it is produced.
 */
public final class PricingEngine {

  /** Guests above capacity a room can take, each paying the room type's extra-guest fee. */
  public static final int MAX_EXTRA_GUESTS_PER_ROOM = 2;

  private PricingEngine() {}

  public static Quote quote(
      Property property,
      RoomType roomType,
      List<SeasonalRate> rates,
      DateRange stay,
      int rooms,
      int guests) {
    if (rooms < 1) {
      throw new ValidationException("at least one room is required");
    }
    int maxGuests = rooms * (roomType.getCapacity() + MAX_EXTRA_GUESTS_PER_ROOM);
    if (guests < 1 || guests > maxGuests) {
      throw new ValidationException(
          "guests must be between 1 and " + maxGuests + " for " + rooms + " room(s)");
    }
    var currency = property.currency();
    var base = Money.of(roomType.getBaseNightlyRate(), currency);
    var lines = new ArrayList<PriceLine>();
    var roomCharges = Money.zero(currency);

    for (LocalDate night : stay.nightDates()) {
      Money rate =
          seasonalRateFor(rates, night)
              .map(seasonal -> Money.of(seasonal.getNightlyRate(), currency))
              .orElse(base);
      if (isWeekendNight(night)) {
        rate = rate.plus(rate.percent(property.getWeekendSurchargePercent()));
      }
      Money nightly = rate.times(rooms);
      lines.add(new PriceLine(PriceKind.NIGHTLY_RATE, night, "Room night", nightly.amount()));
      roomCharges = roomCharges.plus(nightly);
    }

    if (stay.nights() >= property.getLosMinNights() && property.getLosDiscountPercent() > 0) {
      Money discount = roomCharges.percent(property.getLosDiscountPercent());
      lines.add(
          new PriceLine(
              PriceKind.LENGTH_OF_STAY_DISCOUNT,
              null,
              "Length-of-stay discount",
              Money.zero(currency).minus(discount).amount()));
    }

    int extraGuests = guests - rooms * roomType.getCapacity();
    if (extraGuests > 0) {
      Money fee = Money.of(roomType.getExtraGuestFee(), currency).times(extraGuests);
      for (LocalDate night : stay.nightDates()) {
        lines.add(new PriceLine(PriceKind.EXTRA_GUEST_FEE, night, "Extra guest", fee.amount()));
      }
    }

    Money total = Money.zero(currency);
    for (PriceLine line : lines) {
      total = total.plus(Money.of(line.getAmount(), currency));
    }
    return new Quote(roomType.getCode(), stay, rooms, guests, lines, total);
  }

  /** The rate of the seasonal rule with the lowest priority number that covers the night. */
  public static Optional<SeasonalRate> seasonalRateFor(List<SeasonalRate> rates, LocalDate night) {
    return rates.stream()
        .filter(rate -> rate.covers(night))
        .min(Comparator.comparingInt(SeasonalRate::getPriority));
  }

  public static boolean isWeekendNight(LocalDate night) {
    DayOfWeek day = night.getDayOfWeek();
    return day == DayOfWeek.FRIDAY || day == DayOfWeek.SATURDAY;
  }
}
