package com.papertrail.workflow.config;

import com.papertrail.workflow.api.AdminTokenFilter;
import com.papertrail.workflow.api.AuthenticationFilter;
import com.papertrail.workflow.api.CurrentPrincipal;
import com.papertrail.workflow.api.PathGuardFilter;
import com.papertrail.workflow.api.RequestLoggingFilter;
import com.papertrail.workflow.service.IdentityService;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.Ordered;

/**
 * Registers the filters in their order: request logging first, so every answer carries a request id
 * and an access line, then the path guard, so nothing below sees an encoded or parameterised path.
 * The user filter must run after Boot's request-context filter (order -105), because the
 * request-scoped principal does not exist before it: a filter placed earlier fails with a scope
 * error on every user route.
 */
@Configuration(proxyBeanMethods = false)
public class WebConfig {

  /** Runs after Boot's OrderedRequestContextFilter (-105), which opens the request scope. */
  static final int AFTER_REQUEST_CONTEXT = -100;

  @Bean
  public FilterRegistrationBean<PathGuardFilter> pathGuardFilter() {
    var registration = new FilterRegistrationBean<>(new PathGuardFilter());
    registration.addUrlPatterns("/*");
    registration.setOrder(Ordered.HIGHEST_PRECEDENCE + 90);
    return registration;
  }

  @Bean
  public FilterRegistrationBean<RequestLoggingFilter> requestLoggingFilter() {
    var registration = new FilterRegistrationBean<>(new RequestLoggingFilter());
    registration.addUrlPatterns("/*");
    registration.setOrder(Ordered.HIGHEST_PRECEDENCE + 80);
    return registration;
  }

  @Bean
  public FilterRegistrationBean<AdminTokenFilter> adminTokenFilter(WorkflowConfig properties) {
    var registration = new FilterRegistrationBean<>(new AdminTokenFilter(properties.adminToken()));
    registration.addUrlPatterns("/api/v1/admin/*");
    registration.setOrder(AFTER_REQUEST_CONTEXT);
    return registration;
  }

  @Bean
  public FilterRegistrationBean<AuthenticationFilter> authenticationFilter(
      IdentityService identity, CurrentPrincipal current) {
    var registration = new FilterRegistrationBean<>(new AuthenticationFilter(identity, current));
    registration.addUrlPatterns("/api/v1/*");
    registration.setOrder(AFTER_REQUEST_CONTEXT);
    return registration;
  }
}
