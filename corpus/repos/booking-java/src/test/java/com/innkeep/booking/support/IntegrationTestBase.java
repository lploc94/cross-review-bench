package com.innkeep.booking.support;

import com.innkeep.booking.domain.RoomType;
import java.sql.Date;
import java.time.LocalDate;
import org.junit.jupiter.api.BeforeEach;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.web.servlet.MockMvc;

/**
 * Base for tests against the real Postgres the harness leases. All subclasses share one Spring
 * context (same properties, same imports), so Flyway runs once. Each test starts from an empty
 * schema and the clock at {@link TestConfig#START}.
 */
@SpringBootTest(
    properties = {
      "booking.admin-token=test-admin-token",
      "booking.scheduling-enabled=false",
      "booking.lock-timeout=500ms",
      "booking.hold-cleanup-batch-size=2",
      "spring.jpa.properties.hibernate.generate_statistics=true"
    })
@AutoConfigureMockMvc
@Import(TestConfig.class)
public abstract class IntegrationTestBase {

  protected static final String ADMIN_AUTH = "Bearer test-admin-token";

  @Autowired protected MockMvc mvc;
  @Autowired protected JdbcTemplate jdbc;
  @Autowired protected MutableClock clock;
  @Autowired protected RecordingPaymentGateway payments;
  @Autowired protected TestData data;

  @BeforeEach
  void resetState() {
    jdbc.execute(
        "TRUNCATE ledger_entry, reservation_price_line, reservation, hold_price_line, hold,"
            + " inventory, seasonal_rate, room_type, property RESTART IDENTITY CASCADE");
    clock.set(TestConfig.START);
    payments.reset();
  }

  /** Rooms counted as held for the night, read straight from the table. */
  protected int held(RoomType type, LocalDate night) {
    return counter("held", type, night);
  }

  /** Rooms counted as booked for the night, read straight from the table. */
  protected int booked(RoomType type, LocalDate night) {
    return counter("booked", type, night);
  }

  private int counter(String column, RoomType type, LocalDate night) {
    return jdbc.queryForObject(
        "select " + column + " from inventory where room_type_id = ? and night = ?",
        Integer.class,
        type.getId(),
        Date.valueOf(night));
  }
}
