package com.papertrail.workflow.api;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.regex.Pattern;
import org.springframework.http.HttpStatus;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Refuses paths whose meaning depends on decoding or on path parameters: percent-escapes, {@code ;}
 * parameters, backslashes, empty or dot segments. The routes use plain ASCII segments only, so a
 * valid client never sends these. Refusing them keeps the raw path the same as the path the
 * dispatcher routes and the path the security filters check, so no filter can be bypassed by an
 * alternate spelling of a route.
 */
public class PathGuardFilter extends OncePerRequestFilter {

  private static final Pattern AMBIGUOUS = Pattern.compile("[%;\\\\]|//|/\\.\\.?(/|$)");

  @Override
  protected void doFilterInternal(
      HttpServletRequest request, HttpServletResponse response, FilterChain chain)
      throws ServletException, IOException {
    if (AMBIGUOUS.matcher(request.getRequestURI()).find()) {
      ProblemWriter.write(
          response,
          HttpStatus.BAD_REQUEST,
          "ambiguous-path",
          "Ambiguous path",
          "the path must be written without escapes, path parameters or empty segments");
      return;
    }
    chain.doFilter(request, response);
  }
}
