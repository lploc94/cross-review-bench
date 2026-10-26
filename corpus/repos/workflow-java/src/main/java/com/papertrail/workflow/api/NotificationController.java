package com.papertrail.workflow.api;

import com.papertrail.workflow.service.OutboxService;
import com.papertrail.workflow.service.Views.NotificationView;
import com.papertrail.workflow.service.Views.PageView;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** The caller's own notifications: what the workflow told them, without the payload. */
@RestController
@RequestMapping("/api/v1/notifications")
public class NotificationController {

  private final OutboxService outbox;
  private final CurrentPrincipal current;

  public NotificationController(OutboxService outbox, CurrentPrincipal current) {
    this.outbox = outbox;
    this.current = current;
  }

  @GetMapping("/mine")
  public PageView<NotificationView> mine(
      @RequestParam(required = false) Long cursor, @RequestParam(required = false) Integer size) {
    return outbox.notificationsFor(current.require(), cursor, size);
  }
}
