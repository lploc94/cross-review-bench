package com.innkeep.booking.api;

import com.innkeep.booking.api.dto.CancellationQuoteResponse;
import com.innkeep.booking.api.dto.CancellationResponse;
import com.innkeep.booking.api.dto.ReservationResponse;
import com.innkeep.booking.service.ReservationService;
import java.time.Instant;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * Guest-facing reservation routes, addressed by the booking reference. The reference is the only
 * credential these routes check. Listing guests, checking them in and the payment ledger are staff
 * views under {@code /api/v1/admin}, so guest contact details are never open to the public.
 */
@RestController
@RequestMapping("/api/v1/reservations")
public class ReservationController {

  private final ReservationService reservations;

  public ReservationController(ReservationService reservations) {
    this.reservations = reservations;
  }

  @GetMapping("/{reference}")
  public ReservationResponse get(@PathVariable String reference) {
    return ReservationResponse.from(reservations.get(reference));
  }

  @GetMapping("/{reference}/cancellation-quote")
  public CancellationQuoteResponse cancellationQuote(
      @PathVariable String reference, @RequestParam(required = false) Instant at) {
    return CancellationQuoteResponse.from(reservations.quoteCancellation(reference, at));
  }

  @PostMapping("/{reference}/cancel")
  public CancellationResponse cancel(@PathVariable String reference) {
    return CancellationResponse.from(reservations.cancel(reference));
  }
}
