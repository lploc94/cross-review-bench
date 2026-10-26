package com.innkeep.booking.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.innkeep.booking.domain.DateRange;
import com.innkeep.booking.domain.ValidationException;
import java.time.LocalDate;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

class DateRangeTest {

  @Test
  void checkOutDayIsNotANight() {
    var stay = new DateRange(LocalDate.of(2027, 1, 1), LocalDate.of(2027, 1, 4));
    assertThat(stay.nights()).isEqualTo(3);
    assertThat(stay.nightDates())
        .containsExactly(
            LocalDate.of(2027, 1, 1), LocalDate.of(2027, 1, 2), LocalDate.of(2027, 1, 3));
    assertThat(stay.lastNight()).isEqualTo(LocalDate.of(2027, 1, 3));
  }

  @Test
  void includesIsHalfOpen() {
    var stay = new DateRange(LocalDate.of(2027, 1, 1), LocalDate.of(2027, 1, 4));
    assertThat(stay.includesNight(LocalDate.of(2027, 1, 1))).isTrue();
    assertThat(stay.includesNight(LocalDate.of(2027, 1, 3))).isTrue();
    assertThat(stay.includesNight(LocalDate.of(2027, 1, 4))).isFalse();
    assertThat(stay.includesNight(LocalDate.of(2026, 12, 31))).isFalse();
  }

  @Test
  void nightsCrossTheLeapDay() {
    var stay = new DateRange(LocalDate.of(2028, 2, 28), LocalDate.of(2028, 3, 1));
    assertThat(stay.nightDates())
        .containsExactly(LocalDate.of(2028, 2, 28), LocalDate.of(2028, 2, 29));
  }

  @ParameterizedTest
  @CsvSource({"2027-01-05,2027-01-05", "2027-01-05,2027-01-04"})
  void checkOutMustBeAfterCheckIn(String in, String out) {
    assertThatThrownBy(() -> new DateRange(LocalDate.parse(in), LocalDate.parse(out)))
        .isInstanceOf(ValidationException.class);
  }

  @Test
  void bothDatesAreRequired() {
    assertThatThrownBy(() -> new DateRange(null, LocalDate.of(2027, 1, 2)))
        .isInstanceOf(ValidationException.class);
  }
}
