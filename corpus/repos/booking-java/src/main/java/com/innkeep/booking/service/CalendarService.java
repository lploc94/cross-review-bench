package com.innkeep.booking.service;

import com.innkeep.booking.domain.DateRange;
import com.innkeep.booking.domain.Inventory;
import com.innkeep.booking.domain.PricingEngine;
import com.innkeep.booking.domain.Quote;
import com.innkeep.booking.domain.RoomType;
import com.innkeep.booking.domain.SeasonalRate;
import com.innkeep.booking.domain.ValidationException;
import com.innkeep.booking.persistence.InventoryRepository;
import com.innkeep.booking.persistence.SeasonalRateRepository;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.function.Function;
import java.util.stream.Collectors;
import org.springframework.stereotype.Service;

/**
 * A night-by-night view of one room type for the guest site: rooms still free and the price of a
 * single room for that night, weekend surcharge and seasonal rates included.
 */
@Service
public class CalendarService {

  private static final int MAX_NIGHTS = 366;

  private final CatalogService catalog;
  private final InventoryRepository inventory;
  private final SeasonalRateRepository seasonalRates;

  public CalendarService(
      CatalogService catalog, InventoryRepository inventory, SeasonalRateRepository seasonalRates) {
    this.catalog = catalog;
    this.inventory = inventory;
    this.seasonalRates = seasonalRates;
  }

  public List<CalendarDay> calendar(String propertyCode, String roomTypeCode, DateRange range) {
    if (range.nights() > MAX_NIGHTS) {
      throw new ValidationException("at most " + MAX_NIGHTS + " nights at a time");
    }
    RoomType type = catalog.roomType(propertyCode, roomTypeCode);
    LocalDate first = range.checkIn();
    LocalDate last = range.lastNight();
    Map<LocalDate, Inventory> rows =
        inventory.findByRoomTypeIdAndNightBetweenOrderByNightAsc(type.getId(), first, last).stream()
            .collect(Collectors.toMap(Inventory::getNight, Function.identity()));
    List<SeasonalRate> rates = seasonalRates.findOverlapping(List.of(type.getId()), first, last);

    int weekendSurchargePercent = type.getProperty().getWeekendSurchargePercent();
    var days = new ArrayList<CalendarDay>();
    for (LocalDate night : range.nightDates()) {
      Inventory row = rows.get(night);
      int available = row == null ? 0 : row.available();
      // one room, guests at capacity: the quote is the nightly price with no extra-guest fee
      Quote price =
          PricingEngine.quote(
              type.getProperty(),
              type,
              rates,
              new DateRange(night, night.plusDays(1)),
              1,
              type.getCapacity());
      boolean seasonal = PricingEngine.seasonalRateFor(rates, night).isPresent();
      boolean weekend = PricingEngine.isWeekendNight(night) && weekendSurchargePercent > 0;
      days.add(new CalendarDay(night, available, price.total(), seasonal, weekend));
    }
    return days;
  }
}
