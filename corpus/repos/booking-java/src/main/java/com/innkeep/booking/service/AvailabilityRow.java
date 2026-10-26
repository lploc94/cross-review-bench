package com.innkeep.booking.service;

import com.innkeep.booking.domain.Money;

/** A room type that can take the requested rooms on every night, with its quoted total. */
public record AvailabilityRow(
    String roomTypeCode, String roomTypeName, int availableRooms, Money quotedTotal) {}
