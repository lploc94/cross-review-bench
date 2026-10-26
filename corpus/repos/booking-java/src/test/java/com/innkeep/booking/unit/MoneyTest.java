package com.innkeep.booking.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.innkeep.booking.domain.Money;
import java.math.BigDecimal;
import java.util.Currency;
import org.junit.jupiter.api.Test;

class MoneyTest {

  private static final Currency EUR = Currency.getInstance("EUR");
  private static final Currency JPY = Currency.getInstance("JPY");

  @Test
  void roundsToTwoDecimalsWithBankersRounding() {
    assertThat(Money.of(new BigDecimal("2.345"), EUR).amount()).isEqualByComparingTo("2.34");
    assertThat(Money.of(new BigDecimal("2.355"), EUR).amount()).isEqualByComparingTo("2.36");
  }

  @Test
  void yenHasNoMinorUnits() {
    assertThat(Money.of(new BigDecimal("1.5"), JPY).amount()).isEqualByComparingTo("2");
    assertThat(Money.of(new BigDecimal("2.5"), JPY).amount()).isEqualByComparingTo("2");
    assertThat(Money.of(new BigDecimal("2.5"), JPY).amount().scale()).isZero();
  }

  @Test
  void percentRoundsTheResultToMinorUnits() {
    assertThat(Money.of(new BigDecimal("10.00"), EUR).percent(15).amount())
        .isEqualByComparingTo("1.50");
    assertThat(Money.of(new BigDecimal("0.10"), EUR).percent(50).amount())
        .isEqualByComparingTo("0.05");
    assertThat(Money.of(new BigDecimal("0.25"), EUR).percent(10).amount())
        .isEqualByComparingTo("0.02");
  }

  @Test
  void arithmeticKeepsTheCurrencyScale() {
    Money sum = Money.of(new BigDecimal("0.10"), EUR).plus(Money.of(new BigDecimal("0.20"), EUR));
    assertThat(sum.amount()).isEqualByComparingTo("0.30");
    assertThat(sum.amount().scale()).isEqualTo(2);
    assertThat(Money.of(new BigDecimal("7.00"), EUR).times(3).amount())
        .isEqualByComparingTo("21.00");
  }

  @Test
  void refusesToMixCurrencies() {
    Money euros = Money.of(BigDecimal.ONE, EUR);
    Money yen = Money.of(BigDecimal.ONE, JPY);
    assertThatThrownBy(() -> euros.plus(yen)).isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(() -> euros.minus(yen)).isInstanceOf(IllegalArgumentException.class);
  }
}
