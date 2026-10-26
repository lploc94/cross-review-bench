package com.papertrail.workflow.api;

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

/**
 * Gives every request a request id (echoed in {@code X-Request-Id}, put in the log context) and
 * writes one structured access-log line per request. The query string is left out of the line: it
 * can carry search terms and owner names.
 */
public class RequestLoggingFilter extends OncePerRequestFilter {

  public static final String HEADER = "X-Request-Id";
  public static final String MDC_KEY = "requestId";

  private static final Logger ACCESS = LoggerFactory.getLogger("com.papertrail.workflow.access");
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
          kv("path", request.getRequestURI()),
          kv("status", response.getStatus()),
          kv("durationMs", millis));
      MDC.remove(MDC_KEY);
    }
  }

  /** A caller's id is kept only when it is short and plain; anything else gets a fresh one. */
  static String requestId(String incoming) {
    if (incoming != null && SAFE_ID.matcher(incoming).matches()) {
      return incoming;
    }
    return UUID.randomUUID().toString();
  }
}
