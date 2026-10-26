package com.innkeep.booking.service;

import static net.logstash.logback.argument.StructuredArguments.kv;

import com.innkeep.booking.config.BookingConfig;
import java.util.function.Supplier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.orm.ObjectOptimisticLockingFailureException;
import org.springframework.stereotype.Component;

/**
 * Re-runs a whole unit of work when another writer won an optimistic-lock race. Only use cases that
 * re-read their state before deciding are wrapped (confirm, cancel, expire, check-out): the second
 * attempt sees the winner's result and answers with the matching conflict.
 */
@Component
public class OptimisticRetry {

  private static final Logger LOG = LoggerFactory.getLogger(OptimisticRetry.class);

  private final int maxAttempts;

  public OptimisticRetry(BookingConfig config) {
    this.maxAttempts = config.maxRetryAttempts();
  }

  public <T> T run(Supplier<T> unitOfWork) {
    for (int attempt = 1; ; attempt++) {
      try {
        return unitOfWork.get();
      } catch (ObjectOptimisticLockingFailureException e) {
        if (attempt >= maxAttempts) {
          throw e;
        }
        LOG.info("optimistic lock lost, retrying", kv("attempt", attempt));
      }
    }
  }
}
