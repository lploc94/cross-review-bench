package com.innkeep.booking.service;

import com.innkeep.booking.domain.Money;
import java.time.Instant;

/** What cancelling a reservation at a given instant would refund, without cancelling it. */
public record CancellationQuote(Instant at, int refundPercent, Money refund) {}
