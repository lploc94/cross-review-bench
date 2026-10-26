package com.innkeep.booking.service;

import com.innkeep.booking.domain.Money;
import com.innkeep.booking.domain.Reservation;

/** A cancelled reservation and the amount refunded under the property's policy. */
public record CancellationOutcome(Reservation reservation, Money refund) {}
