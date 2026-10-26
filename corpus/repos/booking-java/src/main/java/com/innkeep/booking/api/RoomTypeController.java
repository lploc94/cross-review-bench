package com.innkeep.booking.api;

import com.innkeep.booking.api.dto.CalendarDayResponse;
import com.innkeep.booking.api.dto.RoomTypeResponse;
import com.innkeep.booking.domain.DateRange;
import com.innkeep.booking.service.CalendarService;
import com.innkeep.booking.service.CatalogService;
import java.time.LocalDate;
import java.util.List;
import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** One room type as a guest sees it: its details and a night-by-night calendar. */
@RestController
@RequestMapping("/api/v1/properties/{code}/room-types/{roomType}")
public class RoomTypeController {

  private final CatalogService catalog;
  private final CalendarService calendar;

  public RoomTypeController(CatalogService catalog, CalendarService calendar) {
    this.catalog = catalog;
    this.calendar = calendar;
  }

  @GetMapping
  public RoomTypeResponse roomType(@PathVariable String code, @PathVariable String roomType) {
    return RoomTypeResponse.from(catalog.roomType(code, roomType));
  }

  @GetMapping("/calendar")
  public List<CalendarDayResponse> calendar(
      @PathVariable String code,
      @PathVariable String roomType,
      @RequestParam @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate checkIn,
      @RequestParam @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate checkOut) {
    return calendar.calendar(code, roomType, new DateRange(checkIn, checkOut)).stream()
        .map(CalendarDayResponse::from)
        .toList();
  }
}
