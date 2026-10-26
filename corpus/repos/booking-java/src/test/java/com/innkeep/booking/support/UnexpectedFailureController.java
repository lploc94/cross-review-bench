package com.innkeep.booking.support;

import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.dao.PessimisticLockingFailureException;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/** Routes that fail on purpose, so tests can see how the API answers and logs each failure. */
@RestController
class UnexpectedFailureController {

  @GetMapping("/api/v1/test-only/unexpected-failure")
  String fail() {
    throw new IllegalStateException("datasource password=invented-secret");
  }

  @GetMapping("/api/v1/test-only/integrity-failure")
  String integrity() {
    throw new DataIntegrityViolationException(
        "duplicate key value (reference)=(IK-SECRET)",
        new java.sql.SQLException("duplicate key", "23505"));
  }

  @GetMapping("/api/v1/test-only/lock-failure")
  String lock() {
    throw new PessimisticLockingFailureException("deadlock detected while holding IK-SECRET");
  }
}
