package com.innkeep.booking.domain;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.Currency;
import java.util.Objects;

/**
 * An amount in one currency, always rounded to that currency's minor units with banker's rounding
 * (HALF_EVEN). Arithmetic across currencies is refused.
 */
public record Money(BigDecimal amount, Currency currency) {

  public Money {
    Objects.requireNonNull(amount, "amount");
    Objects.requireNonNull(currency, "currency");
    amount = amount.setScale(currency.getDefaultFractionDigits(), RoundingMode.HALF_EVEN);
  }

  public static Money of(BigDecimal amount, Currency currency) {
    return new Money(amount, currency);
  }

  public static Money zero(Currency currency) {
    return new Money(BigDecimal.ZERO, currency);
  }

  public Money plus(Money other) {
    requireSameCurrency(other);
    return new Money(amount.add(other.amount), currency);
  }

  public Money minus(Money other) {
    requireSameCurrency(other);
    return new Money(amount.subtract(other.amount), currency);
  }

  public Money times(int factor) {
    return new Money(amount.multiply(BigDecimal.valueOf(factor)), currency);
  }

  /** This amount multiplied by {@code percent}/100, rounded to the currency's minor units. */
  public Money percent(int percent) {
    return new Money(
        amount
            .multiply(BigDecimal.valueOf(percent))
            .divide(BigDecimal.valueOf(100), 10, RoundingMode.HALF_EVEN),
        currency);
  }

  public boolean isZero() {
    return amount.signum() == 0;
  }

  public boolean isPositive() {
    return amount.signum() > 0;
  }

  private void requireSameCurrency(Money other) {
    if (!currency.equals(other.currency)) {
      throw new IllegalArgumentException(
          "cannot mix " + currency.getCurrencyCode() + " and " + other.currency.getCurrencyCode());
    }
  }
}
