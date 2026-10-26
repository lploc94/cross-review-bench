package com.papertrail.workflow.config;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableScheduling;

/**
 * Turns the timers on. With scheduling disabled the jobs exist but nothing calls them on a timer.
 */
@Configuration
@EnableScheduling
@ConditionalOnProperty(prefix = "workflow", name = "scheduling-enabled", havingValue = "true")
public class SchedulingConfig {}
