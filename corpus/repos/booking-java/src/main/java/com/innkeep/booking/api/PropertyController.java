package com.innkeep.booking.api;

import com.innkeep.booking.api.dto.OccupancyDayResponse;
import com.innkeep.booking.api.dto.PropertyResponse;
import com.innkeep.booking.api.dto.RoomTypeResponse;
import com.innkeep.booking.domain.DateRange;
import com.innkeep.booking.service.CatalogService;
import com.innkeep.booking.service.OperationsService;
import java.time.LocalDate;
import java.util.List;
import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/properties/{code}")
public class PropertyController {

  private final CatalogService catalog;
  private final OperationsService operations;

  public PropertyController(CatalogService catalog, OperationsService operations) {
    this.catalog = catalog;
    this.operations = operations;
  }

  @GetMapping
  public PropertyResponse property(@PathVariable String code) {
    return PropertyResponse.from(catalog.property(code));
  }

  @GetMapping("/room-types")
  public List<RoomTypeResponse> roomTypes(@PathVariable String code) {
    return catalog.roomTypes(code).stream().map(RoomTypeResponse::from).toList();
  }

  @GetMapping("/occupancy")
  public List<OccupancyDayResponse> occupancy(
      @PathVariable String code,
      @RequestParam @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate checkIn,
      @RequestParam @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate checkOut) {
    return operations.occupancy(code, new DateRange(checkIn, checkOut)).stream()
        .map(OccupancyDayResponse::from)
        .toList();
  }
}
