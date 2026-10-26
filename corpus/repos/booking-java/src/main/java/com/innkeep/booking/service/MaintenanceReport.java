package com.innkeep.booking.service;

/** What one pass of the housekeeping job changed. */
public record MaintenanceReport(int releasedHolds, int completedStays) {}
