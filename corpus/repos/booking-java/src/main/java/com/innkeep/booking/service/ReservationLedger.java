package com.innkeep.booking.service;

import com.innkeep.booking.domain.LedgerEntry;
import com.innkeep.booking.domain.Reservation;
import java.util.List;

/** A reservation with its payment ledger, oldest entry first. */
public record ReservationLedger(Reservation reservation, List<LedgerEntry> entries) {}
