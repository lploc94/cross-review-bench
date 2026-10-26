package com.innkeep.booking.config;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.springframework.mock.env.MockEnvironment;

class DatabaseUrlEnvironmentPostProcessorTest {

  @ParameterizedTest
  @CsvSource({
    "postgres://booking_app:s3cret@db.example.com:6432/booking, jdbc:postgresql://db.example.com:6432/booking, booking_app, s3cret",
    "postgresql://reader:pw@localhost:5432/guest_houses, jdbc:postgresql://localhost:5432/guest_houses, reader, pw"
  })
  void convertsTheLibpqUrl(String url, String jdbc, String user, String password) {
    Map<String, Object> settings = DatabaseUrlEnvironmentPostProcessor.toSpringProperties(url);

    assertThat(settings)
        .containsEntry("spring.datasource.url", jdbc)
        .containsEntry("spring.datasource.username", user)
        .containsEntry("spring.datasource.password", password);
  }

  @Test
  void usesTheDefaultPortWhenTheUrlHasNone() {
    Map<String, Object> settings =
        DatabaseUrlEnvironmentPostProcessor.toSpringProperties("postgres://app@localhost/booking");

    assertThat(settings)
        .containsEntry("spring.datasource.url", "jdbc:postgresql://localhost:5432/booking")
        .containsEntry("spring.datasource.username", "app")
        .doesNotContainKey("spring.datasource.password");
  }

  @Test
  void decodesPercentEncodedCredentials() {
    Map<String, Object> settings =
        DatabaseUrlEnvironmentPostProcessor.toSpringProperties(
            "postgres://app:p%40ss%3Aword@localhost:5432/booking");

    assertThat(settings).containsEntry("spring.datasource.password", "p@ss:word");
  }

  @Test
  void keepsAColonInsideAnEncodedUserName() {
    Map<String, Object> settings =
        DatabaseUrlEnvironmentPostProcessor.toSpringProperties(
            "postgres://us%3Aer:pw%3Ax@localhost:5432/booking");

    assertThat(settings)
        .containsEntry("spring.datasource.username", "us:er")
        .containsEntry("spring.datasource.password", "pw:x");
  }

  @Test
  void aPasswordWithAnUnencodedAtSignIsRefusedWithTheFixInTheMessage() {
    assertThatThrownBy(
            () ->
                DatabaseUrlEnvironmentPostProcessor.toSpringProperties(
                    "postgres://app:p@ss@localhost:5432/booking"))
        .isInstanceOf(IllegalStateException.class)
        .hasMessageContaining("%40");
  }

  @Test
  void keepsTheQueryParameters() {
    Map<String, Object> settings =
        DatabaseUrlEnvironmentPostProcessor.toSpringProperties(
            "postgres://app:pw@localhost:5432/booking?sslmode=disable");

    assertThat(settings)
        .containsEntry(
            "spring.datasource.url", "jdbc:postgresql://localhost:5432/booking?sslmode=disable");
  }

  @ParameterizedTest
  @CsvSource({
    "mysql://app:pw@localhost:3306/booking",
    "postgres://app:pw@localhost:5432/",
    "postgres:///booking"
  })
  void rejectsUrlsThatAreNotPostgresUrlsWithADatabase(String url) {
    assertThatThrownBy(() -> DatabaseUrlEnvironmentPostProcessor.toSpringProperties(url))
        .isInstanceOf(IllegalStateException.class);
  }

  @Test
  void failsWhenTheVariableIsMissing() {
    var processor = new DatabaseUrlEnvironmentPostProcessor();

    assertThatThrownBy(() -> processor.postProcessEnvironment(new MockEnvironment(), null))
        .isInstanceOf(IllegalStateException.class)
        .hasMessageContaining("DATABASE_URL");
  }
}
