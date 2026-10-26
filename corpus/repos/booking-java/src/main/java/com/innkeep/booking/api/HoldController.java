package com.innkeep.booking.api;

import com.innkeep.booking.api.dto.HoldRequest;
import com.innkeep.booking.api.dto.HoldResponse;
import com.innkeep.booking.api.dto.ReservationResponse;
import com.innkeep.booking.domain.DateRange;
import com.innkeep.booking.domain.GuestDetails;
import com.innkeep.booking.domain.Hold;
import com.innkeep.booking.domain.Reservation;
import com.innkeep.booking.service.HoldService;
import jakarta.validation.Valid;
import java.net.URI;
import java.util.UUID;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class HoldController {

  private final HoldService holds;

  public HoldController(HoldService holds) {
    this.holds = holds;
  }

  @PostMapping("/api/v1/properties/{code}/holds")
  public ResponseEntity<HoldResponse> create(
      @PathVariable String code, @Valid @RequestBody HoldRequest request) {
    var stay = new DateRange(request.stay().checkIn(), request.stay().checkOut());
    var guest =
        new GuestDetails(request.guest().name(), request.guest().email(), request.guest().phone());
    Hold hold =
        holds.create(
            code,
            request.stay().roomType(),
            stay,
            request.stay().rooms(),
            request.stay().guests(),
            guest);
    return ResponseEntity.created(URI.create("/api/v1/holds/" + hold.getId()))
        .body(HoldResponse.from(hold));
  }

  @GetMapping("/api/v1/holds/{id}")
  public HoldResponse get(@PathVariable UUID id) {
    return HoldResponse.from(holds.get(id));
  }

  @PostMapping("/api/v1/holds/{id}/release")
  public HoldResponse release(@PathVariable UUID id) {
    return HoldResponse.from(holds.release(id));
  }

  @PostMapping("/api/v1/holds/{id}/confirm")
  public ResponseEntity<ReservationResponse> confirm(@PathVariable UUID id) {
    Reservation reservation = holds.confirm(id);
    return ResponseEntity.created(URI.create("/api/v1/reservations/" + reservation.getReference()))
        .body(ReservationResponse.from(reservation));
  }
}
