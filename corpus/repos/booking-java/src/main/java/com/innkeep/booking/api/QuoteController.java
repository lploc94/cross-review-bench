package com.innkeep.booking.api;

import com.innkeep.booking.api.dto.QuoteResponse;
import com.innkeep.booking.api.dto.StayRequest;
import com.innkeep.booking.domain.DateRange;
import com.innkeep.booking.service.PricingService;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/properties/{code}/quotes")
public class QuoteController {

  private final PricingService pricing;

  public QuoteController(PricingService pricing) {
    this.pricing = pricing;
  }

  @PostMapping
  public QuoteResponse quote(@PathVariable String code, @Valid @RequestBody StayRequest request) {
    var stay = new DateRange(request.checkIn(), request.checkOut());
    return QuoteResponse.from(
        pricing.quote(code, request.roomType(), stay, request.rooms(), request.guests()));
  }
}
