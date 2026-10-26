package com.papertrail.workflow.persistence;

import com.papertrail.workflow.domain.StepDefinition;
import org.springframework.data.jpa.repository.JpaRepository;

public interface StepDefinitionRepository extends JpaRepository<StepDefinition, Long> {

  long countByGroupId(long groupId);
}
