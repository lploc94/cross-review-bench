package com.innkeep.booking.service;

import com.innkeep.booking.config.BookingConfig;
import com.innkeep.booking.domain.DateRange;
import com.innkeep.booking.domain.PricingEngine;
import com.innkeep.booking.domain.Quote;
import com.innkeep.booking.domain.RoomType;
import com.innkeep.booking.domain.SeasonalRate;
import com.innkeep.booking.persistence.SeasonalRateRepository;
import java.util.List;
import org.springframework.stereotype.Service;

/** Prices a stay without touching inventory. The same engine prices holds and availability. */
@Service
public class PricingService {

  private final CatalogService catalog;
  private final SeasonalRateRepository seasonalRates;
  private final BookingConfig config;

  public PricingService(
      CatalogService catalog, SeasonalRateRepository seasonalRates, BookingConfig config) {
    this.catalog = catalog;
    this.seasonalRates = seasonalRates;
    this.config = config;
  }

  public Quote quote(
      String propertyCode, String roomTypeCode, DateRange stay, int rooms, int guests) {
    config.requireWithinLimits(stay, rooms);
    RoomType type = catalog.roomType(propertyCode, roomTypeCode);
    List<SeasonalRate> rates =
        seasonalRates.findOverlapping(List.of(type.getId()), stay.checkIn(), stay.lastNight());
    return PricingEngine.quote(type.getProperty(), type, rates, stay, rooms, guests);
  }
}
