package com.innkeep.booking.unit;

import static org.assertj.core.api.Assertions.assertThat;

import com.innkeep.booking.domain.ReferenceCode;
import java.security.SecureRandom;
import org.junit.jupiter.api.Test;

class ReferenceCodeTest {

  @Test
  void codesHaveThePrefixAndEightReadableCharacters() {
    var random = new SecureRandom();

    for (int i = 0; i < 200; i++) {
      assertThat(ReferenceCode.generate(random)).matches("IK-[23456789A-HJ-NP-Z]{8}");
    }
  }
}
