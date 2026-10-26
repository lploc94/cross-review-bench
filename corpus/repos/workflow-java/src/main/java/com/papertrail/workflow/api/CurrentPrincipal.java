package com.papertrail.workflow.api;

import com.papertrail.workflow.domain.Principal;
import org.springframework.context.annotation.Scope;
import org.springframework.context.annotation.ScopedProxyMode;
import org.springframework.stereotype.Component;
import org.springframework.web.context.WebApplicationContext;

/** The principal of the current request, set by {@link AuthenticationFilter}. */
@Component
@Scope(value = WebApplicationContext.SCOPE_REQUEST, proxyMode = ScopedProxyMode.TARGET_CLASS)
public class CurrentPrincipal {

  private Principal principal;

  public void set(Principal principal) {
    this.principal = principal;
  }

  /** The authenticated principal. The filter sets it before any controller runs. */
  public Principal require() {
    if (principal == null) {
      throw new IllegalStateException("no authenticated principal on this request");
    }
    return principal;
  }
}
