package com.innkeep.booking.api;

import com.innkeep.booking.api.dto.CreatePropertyRequest;
import com.innkeep.booking.api.dto.CreateRoomTypeRequest;
import com.innkeep.booking.api.dto.PolicyRequest;
import com.innkeep.booking.api.dto.PropertyDetailsRequest;
import com.innkeep.booking.api.dto.PropertyResponse;
import com.innkeep.booking.api.dto.RoomRatesRequest;
import com.innkeep.booking.api.dto.RoomTypeResponse;
import com.innkeep.booking.api.dto.SeasonalRateRequest;
import com.innkeep.booking.api.dto.SeasonalRateResponse;
import com.innkeep.booking.domain.Property;
import com.innkeep.booking.domain.RoomType;
import com.innkeep.booking.domain.SeasonalRate;
import com.innkeep.booking.service.CatalogService;
import jakarta.validation.Valid;
import java.net.URI;
import java.util.List;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** Admin writes for the catalogue: properties, room types, their rates and seasonal rates. */
@RestController
@RequestMapping("/api/v1/admin/properties")
public class AdminCatalogController {

  private static final String ROOM_TYPES = "/api/v1/properties/{code}/room-types/{roomType}";

  private final CatalogService catalog;

  public AdminCatalogController(CatalogService catalog) {
    this.catalog = catalog;
  }

  @PostMapping
  public ResponseEntity<PropertyResponse> createProperty(
      @Valid @RequestBody CreatePropertyRequest request) {
    Property property = catalog.createProperty(request.toDraft());
    return ResponseEntity.created(URI.create("/api/v1/properties/" + property.getCode()))
        .body(PropertyResponse.from(property));
  }

  @PutMapping("/{code}")
  public PropertyResponse updateDetails(
      @PathVariable String code, @Valid @RequestBody PropertyDetailsRequest request) {
    return PropertyResponse.from(
        catalog.updateDetails(
            code,
            request.name(),
            request.timeZone(),
            request.checkInTime(),
            request.checkOutTime()));
  }

  @PutMapping("/{code}/policy")
  public PropertyResponse changePolicy(
      @PathVariable String code, @RequestBody PolicyRequest request) {
    return PropertyResponse.from(catalog.changePolicy(code, request.toDraft()));
  }

  @PostMapping("/{code}/room-types")
  public ResponseEntity<RoomTypeResponse> createRoomType(
      @PathVariable String code, @Valid @RequestBody CreateRoomTypeRequest request) {
    RoomType type = catalog.createRoomType(code, request.toDraft());
    return ResponseEntity.created(
            URI.create("/api/v1/properties/" + code + "/room-types/" + type.getCode()))
        .body(RoomTypeResponse.from(type));
  }

  @PutMapping("/{code}/room-types/{roomType}/rates")
  public RoomTypeResponse reprice(
      @PathVariable String code,
      @PathVariable String roomType,
      @Valid @RequestBody RoomRatesRequest request) {
    return RoomTypeResponse.from(
        catalog.reprice(code, roomType, request.baseNightlyRate(), request.extraGuestFee()));
  }

  @PostMapping("/{code}/room-types/{roomType}/seasonal-rates")
  public ResponseEntity<SeasonalRateResponse> addSeasonalRate(
      @PathVariable String code,
      @PathVariable String roomType,
      @Valid @RequestBody SeasonalRateRequest request) {
    SeasonalRate rate = catalog.addSeasonalRate(code, roomType, request.toDraft());
    return ResponseEntity.created(
            URI.create(
                "/api/v1/admin/properties/" + code + "/room-types/" + roomType + "/seasonal-rates"))
        .body(SeasonalRateResponse.from(rate));
  }

  @GetMapping("/{code}/room-types/{roomType}/seasonal-rates")
  public List<SeasonalRateResponse> seasonalRates(
      @PathVariable String code, @PathVariable String roomType) {
    return catalog.seasonalRates(code, roomType).stream().map(SeasonalRateResponse::from).toList();
  }

  @PutMapping("/{code}/room-types/{roomType}/seasonal-rates/{id}")
  public SeasonalRateResponse updateSeasonalRate(
      @PathVariable String code,
      @PathVariable String roomType,
      @PathVariable long id,
      @Valid @RequestBody SeasonalRateRequest request) {
    return SeasonalRateResponse.from(
        catalog.updateSeasonalRate(code, roomType, id, request.toDraft()));
  }

  @DeleteMapping("/{code}/room-types/{roomType}/seasonal-rates/{id}")
  public ResponseEntity<Void> removeSeasonalRate(
      @PathVariable String code, @PathVariable String roomType, @PathVariable long id) {
    catalog.removeSeasonalRate(code, roomType, id);
    return ResponseEntity.noContent().build();
  }
}
