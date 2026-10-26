package com.papertrail.workflow.config;

import com.papertrail.workflow.domain.BusinessCalendar;
import java.time.Clock;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/** The single time source and the business calendar that turns SLAs into due times. */
@Configuration
public class ClockConfig {

  @Bean
  public Clock clock() {
    return Clock.systemUTC();
  }

  @Bean
  public BusinessCalendar businessCalendar(WorkflowConfig properties) {
    return new BusinessCalendar(
        properties.businessZone(), properties.workingStart(), properties.workingEnd());
  }
}
