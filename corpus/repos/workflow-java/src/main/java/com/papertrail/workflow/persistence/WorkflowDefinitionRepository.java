package com.papertrail.workflow.persistence;

import com.papertrail.workflow.domain.WorkflowDefinition;
import java.util.List;
import java.util.Optional;
import org.springframework.data.jpa.repository.EntityGraph;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface WorkflowDefinitionRepository extends JpaRepository<WorkflowDefinition, Long> {

  @Query("select max(d.version) from WorkflowDefinition d where d.name = :name")
  Optional<Integer> findMaxVersion(@Param("name") String name);

  Optional<WorkflowDefinition> findFirstByNameAndPublishedTrueOrderByVersionDesc(String name);

  @Override
  @EntityGraph(attributePaths = {"steps", "steps.assignee", "steps.group"})
  Optional<WorkflowDefinition> findById(Long id);

  @EntityGraph(attributePaths = {"steps", "steps.assignee", "steps.group"})
  List<WorkflowDefinition> findByPublishedTrueOrderByNameAscVersionAsc();

  @EntityGraph(attributePaths = {"steps", "steps.assignee", "steps.group"})
  List<WorkflowDefinition> findByPublishedTrueAndNameOrderByVersionAsc(String name);

  @EntityGraph(attributePaths = {"steps", "steps.assignee", "steps.group"})
  List<WorkflowDefinition> findAllByOrderByNameAscVersionAsc();

  @EntityGraph(attributePaths = {"steps", "steps.assignee", "steps.group"})
  List<WorkflowDefinition> findByNameOrderByVersionAsc(String name);
}
