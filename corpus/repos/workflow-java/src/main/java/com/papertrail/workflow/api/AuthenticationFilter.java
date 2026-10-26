package com.papertrail.workflow.api;

import com.papertrail.workflow.domain.Principal;
import com.papertrail.workflow.service.IdentityService;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.Optional;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Resolves {@code Authorization: Bearer <api token>} into the request's principal for the user
 * routes. Admin routes have their own filter, and requests without a valid token get a 401.
 */
public class AuthenticationFilter extends OncePerRequestFilter {

  private static final String BEARER = "Bearer ";

  private final IdentityService identity;
  private final CurrentPrincipal current;

  public AuthenticationFilter(IdentityService identity, CurrentPrincipal current) {
    this.identity = identity;
    this.current = current;
  }

  /**
   * The path guard has refused every encoded or parameterised path before this runs, so the raw
   * path is the routed path. Admin routes belong to the admin filter.
   */
  @Override
  protected boolean shouldNotFilter(HttpServletRequest request) {
    String path = request.getRequestURI();
    return !path.startsWith("/api/v1/") || path.startsWith("/api/v1/admin/");
  }

  @Override
  protected void doFilterInternal(
      HttpServletRequest request, HttpServletResponse response, FilterChain chain)
      throws ServletException, IOException {
    String header = request.getHeader("Authorization");
    String presented =
        header != null && header.startsWith(BEARER)
            ? header.substring(BEARER.length()).trim()
            : null;
    Optional<Principal> principal = identity.authenticate(presented);
    if (principal.isEmpty()) {
      ProblemWriter.unauthorized(response, "a valid API token is required");
      return;
    }
    current.set(principal.get());
    chain.doFilter(request, response);
  }
}
