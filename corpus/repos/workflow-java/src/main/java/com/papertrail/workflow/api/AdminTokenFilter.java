package com.papertrail.workflow.api;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Lets requests through to {@code /api/v1/admin/**} only with {@code Authorization: Bearer <admin
 * token>}. Both values are hashed first, so the comparison takes the same time whatever the
 * presented token's length.
 */
public class AdminTokenFilter extends OncePerRequestFilter {

  private static final String BEARER = "Bearer ";

  private final byte[] expectedDigest;

  public AdminTokenFilter(String adminToken) {
    this.expectedDigest = digest(adminToken);
  }

  @Override
  protected void doFilterInternal(
      HttpServletRequest request, HttpServletResponse response, FilterChain chain)
      throws ServletException, IOException {
    String header = request.getHeader("Authorization");
    String presented =
        header != null && header.startsWith(BEARER) ? header.substring(BEARER.length()) : "";
    if (MessageDigest.isEqual(expectedDigest, digest(presented))) {
      chain.doFilter(request, response);
      return;
    }
    ProblemWriter.unauthorized(response, "a valid admin token is required");
  }

  private static byte[] digest(String value) {
    try {
      return MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
    } catch (NoSuchAlgorithmException e) {
      throw new IllegalStateException("SHA-256 is not available", e);
    }
  }
}
