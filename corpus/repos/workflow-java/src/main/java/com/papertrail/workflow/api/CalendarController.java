package com.papertrail.workflow.api;

import com.papertrail.workflow.domain.BusinessCalendar;
import com.papertrail.workflow.domain.ValidationException;
import com.papertrail.workflow.service.Views.DueView;
import com.papertrail.workflow.service.Views.WorkingHoursView;
import java.time.Duration;
import java.time.Instant;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * Works out when an SLA ends: a working-time allowance counted from a start instant, in the
 * business calendar, so a client can show the due time before a task exists.
 */
@RestController
@RequestMapping("/api/v1/calendar")
public class CalendarController {

  static final int MAX_MINUTES = 43_200;
  static final Instant EARLIEST = Instant.parse("1970-01-01T00:00:00Z");
  static final Instant LATEST = Instant.parse("9999-12-31T23:59:59Z");

  private final BusinessCalendar calendar;

  public CalendarController(BusinessCalendar calendar) {
    this.calendar = calendar;
  }

  @GetMapping("/working-hours")
  public WorkingHoursView workingHours() {
    return new WorkingHoursView(calendar.getZone().getId(), calendar.getStart(), calendar.getEnd());
  }

  @GetMapping("/due")
  public DueView due(@RequestParam Instant from, @RequestParam int minutes) {
    if (minutes < 1 || minutes > MAX_MINUTES) {
      throw new ValidationException("minutes must be between 1 and " + MAX_MINUTES);
    }
    if (from.isBefore(EARLIEST) || from.isAfter(LATEST)) {
      throw new ValidationException("from must be between 1970 and 9999");
    }
    return new DueView(from, minutes, calendar.dueAt(from, Duration.ofMinutes(minutes)));
  }
}
