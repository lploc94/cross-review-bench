package com.innkeep.booking.persistence;

import com.innkeep.booking.domain.LedgerKind;
import java.math.BigDecimal;

/** The sum of ledger amounts of one kind (charges or refunds). */
public interface KindTotal {

  LedgerKind getKind();

  BigDecimal getTotal();
}
