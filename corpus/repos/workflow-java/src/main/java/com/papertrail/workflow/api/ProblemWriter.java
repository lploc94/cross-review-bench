package com.papertrail.workflow.api;

import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import org.springframework.http.HttpStatus;

/** Writes an RFC 9457 problem body from a filter, where the exception handler does not run. */
final class ProblemWriter {

  private ProblemWriter() {}

  static void unauthorized(HttpServletResponse response, String detail) throws IOException {
    write(response, HttpStatus.UNAUTHORIZED, "unauthorized", "Unauthorized", detail);
    response.setHeader("WWW-Authenticate", "Bearer");
  }

  static void write(
      HttpServletResponse response, HttpStatus status, String slug, String title, String detail)
      throws IOException {
    response.setStatus(status.value());
    response.setContentType("application/problem+json");
    response.setCharacterEncoding("UTF-8");
    response
        .getWriter()
        .write(
            "{\"type\":\"urn:workflow:problem:"
                + slug
                + "\",\"title\":\""
                + title
                + "\",\"status\":"
                + status.value()
                + ",\"detail\":\""
                + detail
                + "\"}");
  }
}
