package com.innkeep.booking.api;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockFilterChain;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

class SecurityHeadersFilterTest {

  @Test
  void apiResponsesAreNeverCached() throws Exception {
    var response = new MockHttpServletResponse();
    new SecurityHeadersFilter()
        .doFilter(
            new MockHttpServletRequest("GET", "/api/v1/reservations"),
            response,
            new MockFilterChain());

    assertThat(response.getHeader("X-Content-Type-Options")).isEqualTo("nosniff");
    assertThat(response.getHeader("X-Frame-Options")).isEqualTo("DENY");
    assertThat(response.getHeader("Referrer-Policy")).isEqualTo("no-referrer");
    assertThat(response.getHeader("Cache-Control")).isEqualTo("no-store");
  }

  @Test
  void otherPathsKeepTheirOwnCaching() throws Exception {
    var response = new MockHttpServletResponse();
    new SecurityHeadersFilter()
        .doFilter(
            new MockHttpServletRequest("GET", "/actuator/health"), response, new MockFilterChain());

    assertThat(response.getHeader("X-Content-Type-Options")).isEqualTo("nosniff");
    assertThat(response.getHeader("Cache-Control")).isNull();
  }
}
