package com.innkeep.booking.service;

import com.innkeep.booking.config.BookingConfig;
import com.innkeep.booking.domain.DateRange;
import com.innkeep.booking.domain.PricingEngine;
import com.innkeep.booking.domain.Property;
import com.innkeep.booking.domain.Quote;
import com.innkeep.booking.domain.RoomType;
import com.innkeep.booking.domain.SeasonalRate;
import com.innkeep.booking.persistence.InventoryRepository;
import com.innkeep.booking.persistence.RoomAvailability;
import com.innkeep.booking.persistence.RoomTypeRepository;
import com.innkeep.booking.persistence.SeasonalRateRepository;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.function.Function;
import java.util.stream.Collectors;
import org.springframework.stereotype.Service;

/**
 * Lists the room types of a property that can take the requested rooms on every night of the stay,
 * with the quoted total. Three queries serve the whole property, whatever its size.
 */
@Service
public class AvailabilityService {

  private final CatalogService catalog;
  private final RoomTypeRepository roomTypes;
  private final InventoryRepository inventory;
  private final SeasonalRateRepository seasonalRates;
  private final BookingConfig config;

  public AvailabilityService(
      CatalogService catalog,
      RoomTypeRepository roomTypes,
      InventoryRepository inventory,
      SeasonalRateRepository seasonalRates,
      BookingConfig config) {
    this.catalog = catalog;
    this.roomTypes = roomTypes;
    this.inventory = inventory;
    this.seasonalRates = seasonalRates;
    this.config = config;
  }

  public List<AvailabilityRow> search(String propertyCode, DateRange stay, int rooms, int guests) {
    config.requireWithinLimits(stay, rooms);
    Property property = catalog.property(propertyCode);
    List<RoomType> types = roomTypes.findByPropertyCodeOrderByCodeAsc(propertyCode);
    Map<Long, RoomAvailability> summary =
        inventory.summarize(propertyCode, stay.checkIn(), stay.lastNight()).stream()
            .collect(Collectors.toMap(RoomAvailability::roomTypeId, Function.identity()));
    List<Long> ids = types.stream().map(RoomType::getId).toList();
    Map<Long, List<SeasonalRate>> ratesByType =
        seasonalRates.findOverlapping(ids, stay.checkIn(), stay.lastNight()).stream()
            .collect(Collectors.groupingBy(rate -> rate.getRoomType().getId()));

    var rows = new ArrayList<AvailabilityRow>();
    for (RoomType type : types) {
      RoomAvailability free = summary.get(type.getId());
      if (free == null || free.nightCount() != stay.nights() || free.minAvailable() < rooms) {
        continue;
      }
      if (guests > rooms * (type.getCapacity() + PricingEngine.MAX_EXTRA_GUESTS_PER_ROOM)) {
        continue;
      }
      Quote quote =
          PricingEngine.quote(
              property,
              type,
              ratesByType.getOrDefault(type.getId(), List.of()),
              stay,
              rooms,
              guests);
      rows.add(
          new AvailabilityRow(type.getCode(), type.getName(), free.minAvailable(), quote.total()));
    }
    return rows;
  }
}
