package com.innkeep.booking.api;

import com.innkeep.booking.api.dto.AvailabilityResponse;
import com.innkeep.booking.domain.DateRange;
import com.innkeep.booking.service.AvailabilityService;
import jakarta.validation.constraints.Min;
import java.time.LocalDate;
import java.util.List;
import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@Validated
@RestController
@RequestMapping("/api/v1/properties/{code}/availability")
public class AvailabilityController {

  private final AvailabilityService availability;

  public AvailabilityController(AvailabilityService availability) {
    this.availability = availability;
  }

  @GetMapping
  public List<AvailabilityResponse> search(
      @PathVariable String code,
      @RequestParam @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate checkIn,
      @RequestParam @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate checkOut,
      @RequestParam(defaultValue = "1") @Min(1) int rooms,
      @RequestParam(defaultValue = "1") @Min(1) int guests,
      @RequestParam(required = false) String roomType) {
    return availability.search(code, new DateRange(checkIn, checkOut), rooms, guests).stream()
        .filter(row -> roomType == null || row.roomTypeCode().equals(roomType))
        .map(AvailabilityResponse::from)
        .toList();
  }
}
