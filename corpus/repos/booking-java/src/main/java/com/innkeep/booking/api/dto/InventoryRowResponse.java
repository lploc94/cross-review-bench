package com.innkeep.booking.api.dto;

import com.innkeep.booking.domain.Inventory;
import java.time.LocalDate;

/** One night of inventory as the admin sees it: what is set, held, booked and still free. */
public record InventoryRowResponse(
    LocalDate night, int total, int held, int booked, int available) {

  public static InventoryRowResponse from(Inventory row) {
    return new InventoryRowResponse(
        row.getNight(), row.getTotal(), row.getHeld(), row.getBooked(), row.available());
  }
}
