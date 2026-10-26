package com.papertrail.workflow.integration;

import com.papertrail.workflow.config.WorkflowConfig;
import com.papertrail.workflow.service.SlaService;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/** Escalates overdue tasks on a timer. The timer exists only when scheduling is enabled. */
@Component
public class SlaEscalationJob {

  private final SlaService sla;
  private final WorkflowConfig properties;

  public SlaEscalationJob(SlaService sla, WorkflowConfig properties) {
    this.sla = sla;
    this.properties = properties;
  }

  @Scheduled(fixedDelayString = "${workflow.job-interval}")
  public void run() {
    runOnce();
  }

  public int runOnce() {
    return sla.escalateOverdue(properties.escalationBatchSize());
  }
}
