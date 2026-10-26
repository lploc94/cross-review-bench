package com.papertrail.workflow.persistence;

import com.papertrail.workflow.domain.UserGroup;
import java.util.List;
import java.util.Optional;
import org.springframework.data.jpa.repository.EntityGraph;
import org.springframework.data.jpa.repository.JpaRepository;

public interface UserGroupRepository extends JpaRepository<UserGroup, Long> {

  Optional<UserGroup> findByName(String name);

  /** Members are fetched with the groups, so listing n groups does not run n member queries. */
  @EntityGraph(attributePaths = "members")
  List<UserGroup> findAllByOrderByNameAsc();
}
