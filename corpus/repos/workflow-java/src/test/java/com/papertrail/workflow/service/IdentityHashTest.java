package com.papertrail.workflow.service;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

class IdentityHashTest {

  @Test
  void sha256MatchesTheStandardVector() {
    assertThat(IdentityService.sha256("abc"))
        .isEqualTo("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  }

  @Test
  void tokenSecretsHashToFixedWidthHex() {
    assertThat(IdentityService.sha256("a".repeat(32))).hasSize(64).matches("[0-9a-f]{64}");
  }
}
