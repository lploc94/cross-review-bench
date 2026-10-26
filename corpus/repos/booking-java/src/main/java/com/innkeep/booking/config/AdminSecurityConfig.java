package com.innkeep.booking.config;

import com.innkeep.booking.api.AdminTokenFilter;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/** Guards the admin routes with the static admin token. Guest routes stay open. */
@Configuration
public class AdminSecurityConfig {

  @Bean
  public FilterRegistrationBean<AdminTokenFilter> adminTokenFilter(BookingConfig config) {
    FilterRegistrationBean<AdminTokenFilter> registration =
        new FilterRegistrationBean<>(new AdminTokenFilter(config.adminToken()));
    registration.addUrlPatterns("/api/v1/admin/*");
    registration.setOrder(1);
    return registration;
  }
}
