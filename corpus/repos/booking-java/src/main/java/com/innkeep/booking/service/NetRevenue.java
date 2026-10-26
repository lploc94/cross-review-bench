package com.innkeep.booking.service;

import java.math.BigDecimal;
import java.time.LocalDate;

/** Money charged and refunded in a period, by ledger entry date in the property's time zone. */
public record NetRevenue(
    LocalDate from,
    LocalDate to,
    String currency,
    BigDecimal charged,
    BigDecimal refunded,
    BigDecimal net) {}
