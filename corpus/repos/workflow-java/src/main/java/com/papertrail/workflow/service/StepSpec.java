package com.papertrail.workflow.service;

import com.papertrail.workflow.domain.StepKind;

/**
 * One step of a definition as a service call receives it; ids refer to existing users or groups.
 */
public record StepSpec(
    int order, StepKind kind, Long assigneeId, Long groupId, int quorum, int slaMinutes) {}
