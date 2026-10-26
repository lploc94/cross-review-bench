package com.innkeep.booking.api.dto;

import com.innkeep.booking.service.OccupancyDay;
import java.math.BigDecimal;
import java.time.LocalDate;

public record OccupancyDayResponse(
    LocalDate night, int totalRooms, int heldRooms, int bookedRooms, BigDecimal percentInUse) {

  public static OccupancyDayResponse from(OccupancyDay day) {
    return new OccupancyDayResponse(
        day.night(), day.totalRooms(), day.heldRooms(), day.bookedRooms(), day.percentInUse());
  }
}
