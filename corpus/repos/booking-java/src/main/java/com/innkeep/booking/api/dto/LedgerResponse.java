package com.innkeep.booking.api.dto;

import com.innkeep.booking.domain.LedgerEntry;
import com.innkeep.booking.domain.LedgerKind;
import com.innkeep.booking.service.ReservationLedger;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;

/** The payment ledger of one reservation. Gateway references are returned, card data never is. */
public record LedgerResponse(String reference, String currency, List<Entry> entries) {

  public record Entry(
      long id,
      LedgerKind kind,
      BigDecimal amount,
      String reason,
      String gatewayReference,
      Instant createdAt) {

    static Entry from(LedgerEntry entry) {
      return new Entry(
          entry.getId(),
          entry.getKind(),
          entry.getAmount(),
          entry.getReason(),
          entry.getGatewayReference(),
          entry.getCreatedAt());
    }
  }

  public static LedgerResponse from(ReservationLedger ledger) {
    return new LedgerResponse(
        ledger.reservation().getReference(),
        ledger.reservation().getTotal().currency().getCurrencyCode(),
        ledger.entries().stream().map(Entry::from).toList());
  }
}
