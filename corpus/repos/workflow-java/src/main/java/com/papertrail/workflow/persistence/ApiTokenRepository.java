package com.papertrail.workflow.persistence;

import com.papertrail.workflow.domain.ApiToken;
import java.util.List;
import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface ApiTokenRepository extends JpaRepository<ApiToken, Long> {

  @Query("select t from ApiToken t join fetch t.user where t.prefix = :prefix")
  Optional<ApiToken> findWithUserByPrefix(@Param("prefix") String prefix);

  List<ApiToken> findByUserIdAndRevokedAtIsNull(long userId);

  List<ApiToken> findByUserIdOrderByIdAsc(long userId);
}
