package com.innkeep.booking.persistence;

import com.innkeep.booking.domain.ReservationStatus;

/** One row of the reservation count per status. */
public interface StatusCount {

  ReservationStatus getStatus();

  long getTotal();
}
