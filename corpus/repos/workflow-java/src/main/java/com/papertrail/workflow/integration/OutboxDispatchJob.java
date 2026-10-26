package com.papertrail.workflow.integration;

import com.papertrail.workflow.integration.OutboxDispatcher.DispatchResult;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/** Runs the dispatcher on a timer. The timer exists only when scheduling is enabled. */
@Component
public class OutboxDispatchJob {

  private final OutboxDispatcher dispatcher;

  public OutboxDispatchJob(OutboxDispatcher dispatcher) {
    this.dispatcher = dispatcher;
  }

  @Scheduled(fixedDelayString = "${workflow.job-interval}")
  public void run() {
    runOnce();
  }

  public DispatchResult runOnce() {
    return dispatcher.dispatchDue();
  }
}
