package com.innkeep.booking.persistence;

import com.innkeep.booking.domain.HoldStatus;

/** One row of the hold count per status. */
public interface HoldStatusCount {

  HoldStatus getStatus();

  long getTotal();
}
