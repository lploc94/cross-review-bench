package com.papertrail.workflow.api;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

class RequestLoggingFilterTest {

  @Test
  void aPlainCallerIdIsKept() {
    assertThat(RequestLoggingFilter.requestId("req-2027-05-03")).isEqualTo("req-2027-05-03");
  }

  @Test
  void anUnsafeOrOverlongIdIsReplaced() {
    assertThat(RequestLoggingFilter.requestId("bad id with spaces"))
        .isNotEqualTo("bad id with spaces");
    assertThat(RequestLoggingFilter.requestId("x".repeat(65))).hasSize(36);
    assertThat(RequestLoggingFilter.requestId(null)).hasSize(36);
  }
}
