package com.innkeep.booking.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.innkeep.booking.support.LogCapture;
import jakarta.servlet.FilterChain;
import jakarta.servlet.http.HttpServletResponse;
import org.junit.jupiter.api.Test;
import org.slf4j.MDC;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.web.servlet.HandlerMapping;

class RequestLoggingFilterTest {

  private static final String ACCESS_LOG = "com.innkeep.booking.access";

  @Test
  void aPlainCallerIdIsKept() {
    assertThat(RequestLoggingFilter.requestId("req-2027-06-01")).isEqualTo("req-2027-06-01");
  }

  @Test
  void anUnsafeOrMissingIdIsReplacedByAFreshOne() {
    assertThat(RequestLoggingFilter.requestId("a b\nc")).matches("[0-9a-f-]{36}");
    assertThat(RequestLoggingFilter.requestId(null)).matches("[0-9a-f-]{36}");
    assertThat(RequestLoggingFilter.requestId("x".repeat(65))).matches("[0-9a-f-]{36}");
  }

  @Test
  void theIdIsEchoedAndTheLogContextIsClearedAfterwards() throws Exception {
    var request = new MockHttpServletRequest("GET", "/api/v1/properties/harbour-house");
    request.addHeader(RequestLoggingFilter.HEADER, "trace-42");
    var response = new MockHttpServletResponse();
    var seen = new String[1];
    FilterChain chain =
        (req, res) -> {
          seen[0] = MDC.get(RequestLoggingFilter.MDC_KEY);
          ((HttpServletResponse) res).setStatus(200);
        };

    new RequestLoggingFilter().doFilter(request, response, chain);

    assertThat(response.getHeader(RequestLoggingFilter.HEADER)).isEqualTo("trace-42");
    assertThat(seen[0]).isEqualTo("trace-42");
    assertThat(MDC.get(RequestLoggingFilter.MDC_KEY)).isNull();
  }

  @Test
  void theRequestIdIsSetEvenWhenTheChainFails() {
    var request = new MockHttpServletRequest("GET", "/api/v1/nothing");
    var response = new MockHttpServletResponse();
    FilterChain failing =
        (req, res) -> {
          throw new IllegalStateException("boom");
        };

    assertThatThrownBy(() -> new RequestLoggingFilter().doFilter(request, response, failing))
        .isInstanceOf(IllegalStateException.class);

    assertThat(response.getHeader(RequestLoggingFilter.HEADER)).matches("[0-9a-f-]{36}");
    assertThat(MDC.get(RequestLoggingFilter.MDC_KEY)).isNull();
  }

  @Test
  void theAccessLogNamesTheRouteTemplateNotTheCallerSuppliedPath() throws Exception {
    String logged =
        accessLogOf(
            "/api/v1/reservations/RX-SECRET-1234",
            request -> {
              // What the dispatcher records once the handler mapping has matched the route.
              request.setAttribute(
                  HandlerMapping.BEST_MATCHING_PATTERN_ATTRIBUTE,
                  "/api/v1/reservations/{reference}");
            });

    assertThat(logged).contains("\"path\":\"/api/v1/reservations/{reference}\"");
    assertThat(logged).doesNotContain("RX-SECRET-1234");
  }

  @Test
  void aRequestThatMatchesNoRouteIsLoggedAsUnmatched() throws Exception {
    String logged = accessLogOf("/api/v1/holds/3f2a-not-a-route/RX-SECRET-1234", request -> {});

    assertThat(logged).contains("\"path\":\"unmatched\"");
    assertThat(logged).doesNotContain("RX-SECRET-1234");
  }

  private static String accessLogOf(
      String uri, java.util.function.Consumer<MockHttpServletRequest> dispatch) throws Exception {
    return LogCapture.during(
        ACCESS_LOG,
        () -> {
          var request = new MockHttpServletRequest("GET", uri);
          dispatch.accept(request);
          new RequestLoggingFilter()
              .doFilter(request, new MockHttpServletResponse(), (req, res) -> {});
        });
  }
}
