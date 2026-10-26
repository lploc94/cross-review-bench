package com.innkeep.booking.service;

import static net.logstash.logback.argument.StructuredArguments.kv;

import com.innkeep.booking.config.BookingConfig;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Periodic housekeeping: expires holds whose time has passed (releasing their rooms) and completes
 * stays whose check-out date has come. Each batch is drained until a pass finds nothing left. Tests
 * switch the schedule off and call these methods directly.
 */
@Component
public class BookingMaintenanceJob {

  private static final Logger LOG = LoggerFactory.getLogger(BookingMaintenanceJob.class);

  private final HoldService holds;
  private final ReservationService reservations;
  private final BookingConfig config;

  public BookingMaintenanceJob(
      HoldService holds, ReservationService reservations, BookingConfig config) {
    this.holds = holds;
    this.reservations = reservations;
    this.config = config;
  }

  @Scheduled(
      fixedDelayString = "${booking.hold-cleanup-interval}",
      initialDelayString = "${booking.hold-cleanup-interval}")
  public MaintenanceReport run() {
    MaintenanceReport report =
        new MaintenanceReport(releaseExpiredHolds(), completeDepartedStays());
    LOG.info(
        "maintenance pass finished",
        kv("releasedHolds", report.releasedHolds()),
        kv("completedStays", report.completedStays()));
    return report;
  }

  /** Returns the number of holds expired. */
  public int releaseExpiredHolds() {
    return holds.releaseExpired(config.holdCleanupBatchSize());
  }

  /** Returns the number of stays completed. */
  public int completeDepartedStays() {
    return reservations.completeDepartedStays(config.holdCleanupBatchSize());
  }
}
