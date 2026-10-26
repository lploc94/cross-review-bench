package com.innkeep.booking.api;

import static net.logstash.logback.argument.StructuredArguments.kv;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.UUID;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.web.filter.OncePerRequestFilter;
import org.springframework.web.servlet.HandlerMapping;

/**
 * Gives every request a request id (echoed in {@code X-Request-Id}, put in the log context) and
 * writes one structured access-log line per request. The line names the route template, never the
 * raw path or query string: those can carry hold ids, reservation references and guest email
 * filters.
 */
public class RequestLoggingFilter extends OncePerRequestFilter {

  public static final String HEADER = "X-Request-Id";
  public static final String MDC_KEY = "requestId";

  private static final Logger ACCESS = LoggerFactory.getLogger("com.innkeep.booking.access");
  private static final String UNMATCHED_ROUTE = "unmatched";
  private static final Pattern SAFE_ID = Pattern.compile("[A-Za-z0-9-]{1,64}");

  @Override
  protected void doFilterInternal(
      HttpServletRequest request, HttpServletResponse response, FilterChain chain)
      throws ServletException, IOException {
    String requestId = requestId(request.getHeader(HEADER));
    MDC.put(MDC_KEY, requestId);
    response.setHeader(HEADER, requestId);
    long started = System.nanoTime();
    try {
      chain.doFilter(request, response);
    } finally {
      long millis = (System.nanoTime() - started) / 1_000_000;
      ACCESS.info(
          "request completed",
          kv("method", request.getMethod()),
          kv("path", route(request)),
          kv("status", response.getStatus()),
          kv("durationMs", millis));
      MDC.remove(MDC_KEY);
    }
  }

  /**
   * The route template the request matched, such as {@code /api/v1/reservations/{reference}}. The
   * raw path is never logged: it carries hold ids and reservation references, which work as
   * credentials. A request that matched no route is logged as {@code unmatched}.
   */
  private static String route(HttpServletRequest request) {
    Object template = request.getAttribute(HandlerMapping.BEST_MATCHING_PATTERN_ATTRIBUTE);
    return template instanceof String pattern ? pattern : UNMATCHED_ROUTE;
  }

  /** A caller's id is kept only when it is short and plain; anything else gets a fresh one. */
  static String requestId(String incoming) {
    if (incoming != null && SAFE_ID.matcher(incoming).matches()) {
      return incoming;
    }
    return UUID.randomUUID().toString();
  }
}
