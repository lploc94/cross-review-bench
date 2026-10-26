package com.papertrail.workflow.persistence;

import com.papertrail.workflow.domain.AppUser;
import java.util.List;
import java.util.Optional;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;

public interface AppUserRepository extends JpaRepository<AppUser, Long> {

  List<AppUser> findByIdGreaterThanOrderByIdAsc(long after, Pageable page);

  List<AppUser> findByActiveAndIdGreaterThanOrderByIdAsc(boolean active, long after, Pageable page);

  long countByActive(boolean active);

  Optional<AppUser> findByEmail(String email);
}
