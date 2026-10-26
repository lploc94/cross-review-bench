package com.innkeep.booking.config;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableScheduling;

/** Turns on {@code @Scheduled} jobs; tests switch them off and invoke the jobs directly. */
@Configuration
@EnableScheduling
@ConditionalOnProperty(
    prefix = "booking",
    name = "scheduling-enabled",
    havingValue = "true",
    matchIfMissing = true)
public class SchedulingConfig {}
