package com.innkeep.booking.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.innkeep.booking.domain.ConflictException;
import com.innkeep.booking.domain.DateRange;
import com.innkeep.booking.domain.Hold;
import com.innkeep.booking.domain.HoldExpiredException;
import com.innkeep.booking.domain.HoldStatus;
import com.innkeep.booking.domain.Property;
import com.innkeep.booking.domain.RoomType;
import com.innkeep.booking.support.Fixtures;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class HoldTest {

  private static final Instant CREATED = Instant.parse("2027-05-01T10:00:00Z");
  private static final Instant EXPIRES = CREATED.plus(Duration.ofMinutes(15));

  private Property property;
  private RoomType room;
  private Hold hold;

  @BeforeEach
  void setUp() {
    property = Fixtures.property("Europe/Lisbon", 0, 0);
    room = Fixtures.roomType(property, 2, "100.00");
    var stay = new DateRange(LocalDate.parse("2027-06-01"), LocalDate.parse("2027-06-03"));
    hold = Fixtures.hold(property, room, stay, CREATED);
  }

  @Test
  void expiresExactlyAtTheTimeLimit() {
    assertThat(hold.getExpiresAt()).isEqualTo(EXPIRES);
    assertThat(hold.isExpiredAt(EXPIRES.minusNanos(1))).isFalse();
    assertThat(hold.isExpiredAt(EXPIRES)).isTrue();
  }

  @Test
  void activeHoldAtTheLimitCannotBeConfirmed() {
    assertThatThrownBy(() -> hold.requireUsable(EXPIRES)).isInstanceOf(HoldExpiredException.class);
  }

  @Test
  void activeHoldJustBeforeTheLimitIsUsable() {
    hold.requireUsable(EXPIRES.minusNanos(1));
    assertThat(hold.getStatus()).isEqualTo(HoldStatus.ACTIVE);
  }

  @Test
  void aConfirmedHoldCannotBeConfirmedOrReleasedAgain() {
    hold.markConfirmed();

    assertThatThrownBy(() -> hold.requireUsable(CREATED))
        .isInstanceOf(ConflictException.class)
        .hasMessageContaining("already confirmed");
    assertThatThrownBy(hold::markReleased).isInstanceOf(ConflictException.class);
  }

  @Test
  void aReleasedHoldCannotBeConfirmed() {
    hold.markReleased();

    assertThatThrownBy(() -> hold.requireUsable(CREATED)).isInstanceOf(ConflictException.class);
  }

  @Test
  void anExpiredHoldIsGoneEvenBeforeItsTimeIsChecked() {
    hold.markExpired();

    assertThatThrownBy(() -> hold.requireUsable(CREATED)).isInstanceOf(HoldExpiredException.class);
  }

  @Test
  void theHoldCarriesTheQuotedTotalAndLines() {
    assertThat(hold.getTotal().amount()).isEqualByComparingTo("200.00");
    assertThat(hold.getPriceLines()).hasSize(2);
  }
}
