package com.innkeep.booking.api;

import com.innkeep.booking.api.dto.InventoryRangeRequest;
import com.innkeep.booking.api.dto.InventoryRowResponse;
import com.innkeep.booking.api.dto.InventoryUpdateRequest;
import com.innkeep.booking.domain.DateRange;
import com.innkeep.booking.service.CatalogService;
import jakarta.validation.Valid;
import java.time.LocalDate;
import java.util.List;
import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/admin/properties/{code}/room-types/{roomType}")
public class AdminInventoryController {

  private final CatalogService catalog;

  public AdminInventoryController(CatalogService catalog) {
    this.catalog = catalog;
  }

  @GetMapping("/inventory")
  public List<InventoryRowResponse> inventory(
      @PathVariable String code,
      @PathVariable String roomType,
      @RequestParam @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate from,
      @RequestParam @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate to) {
    return catalog.inventory(code, roomType, new DateRange(from, to)).stream()
        .map(InventoryRowResponse::from)
        .toList();
  }

  @PutMapping("/inventory/range")
  public ResponseEntity<Void> setInventoryRange(
      @PathVariable String code,
      @PathVariable String roomType,
      @Valid @RequestBody InventoryRangeRequest request) {
    catalog.setInventoryRange(code, roomType, request.range(), request.total());
    return ResponseEntity.noContent().build();
  }

  @PutMapping("/inventory")
  public ResponseEntity<Void> setInventory(
      @PathVariable String code,
      @PathVariable String roomType,
      @Valid @RequestBody InventoryUpdateRequest request) {
    catalog.setInventory(code, roomType, request.toNightTotals());
    return ResponseEntity.noContent().build();
  }
}
