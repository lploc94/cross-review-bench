package com.papertrail.workflow.config;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.ValueSource;

class DatabaseUrlEnvironmentPostProcessorTest {

  @ParameterizedTest
  @CsvSource({
    "postgres://workflow_app:s3cret@db.example.com:6432/workflow, jdbc:postgresql://db.example.com:6432/workflow, workflow_app, s3cret",
    "postgresql://reader:pw@localhost:5432/approvals, jdbc:postgresql://localhost:5432/approvals, reader, pw"
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
        DatabaseUrlEnvironmentPostProcessor.toSpringProperties("postgres://app@localhost/workflow");

    assertThat(settings)
        .containsEntry("spring.datasource.url", "jdbc:postgresql://localhost:5432/workflow");
  }

  @Test
  void decodesPercentEncodedCredentials() {
    Map<String, Object> settings =
        DatabaseUrlEnvironmentPostProcessor.toSpringProperties(
            "postgres://app:p%40ss%3Aword@localhost:5432/workflow");

    assertThat(settings).containsEntry("spring.datasource.password", "p@ss:word");
  }

  @Test
  void keepsTheQueryParameters() {
    Map<String, Object> settings =
        DatabaseUrlEnvironmentPostProcessor.toSpringProperties(
            "postgres://app:pw@localhost:5432/workflow?sslmode=disable");

    assertThat(settings)
        .containsEntry(
            "spring.datasource.url", "jdbc:postgresql://localhost:5432/workflow?sslmode=disable");
  }

  @ParameterizedTest
  @ValueSource(
      strings = {
        "mysql://app@localhost/workflow",
        "postgres://app@localhost",
        "postgres:///workflow"
      })
  void rejectsUrlsWithoutAPostgresSchemeHostOrDatabase(String url) {
    assertThatThrownBy(() -> DatabaseUrlEnvironmentPostProcessor.toSpringProperties(url))
        .isInstanceOf(IllegalStateException.class);
  }

  @Test
  void aHostMayContainUnderscores() {
    Map<String, Object> settings =
        DatabaseUrlEnvironmentPostProcessor.toSpringProperties(
            "postgres://app:pw@workflow_db_host:5433/workflow");

    assertThat(settings)
        .containsEntry("spring.datasource.url", "jdbc:postgresql://workflow_db_host:5433/workflow");
  }

  @Test
  void theUserNameIsDecodedAfterTheSeparatorIsFound() {
    Map<String, Object> settings =
        DatabaseUrlEnvironmentPostProcessor.toSpringProperties(
            "postgres://us%3Aer:pw@localhost/workflow");

    assertThat(settings)
        .containsEntry("spring.datasource.username", "us:er")
        .containsEntry("spring.datasource.password", "pw");
  }

  @Test
  void aDatabaseNameWithReservedCharactersIsRefusedRatherThanSpliced() {
    assertThatThrownBy(
            () ->
                DatabaseUrlEnvironmentPostProcessor.toSpringProperties(
                    "postgres://app:pw@localhost/my%3Fdb"))
        .isInstanceOf(IllegalStateException.class);
  }

  @Test
  void anIpv6HostKeepsItsBracketsAndPort() {
    assertThat(
            DatabaseUrlEnvironmentPostProcessor.toSpringProperties(
                "postgres://user:pw@[::1]:5432/app"))
        .containsEntry("spring.datasource.url", "jdbc:postgresql://[::1]:5432/app");
  }

  @Test
  void anIpv6HostUsesTheDefaultPort() {
    assertThat(DatabaseUrlEnvironmentPostProcessor.toSpringProperties("postgres://user@[::1]/app"))
        .containsEntry("spring.datasource.url", "jdbc:postgresql://[::1]:5432/app");
  }

  @Test
  void aPortOfZeroIsRefused() {
    assertThatThrownBy(
            () ->
                DatabaseUrlEnvironmentPostProcessor.toSpringProperties(
                    "postgres://u:p@localhost:0/app"))
        .isInstanceOf(IllegalStateException.class)
        .hasMessageContaining("port");
  }

  @Test
  void aPortAboveTheValidRangeIsRefused() {
    assertThatThrownBy(
            () ->
                DatabaseUrlEnvironmentPostProcessor.toSpringProperties(
                    "postgres://u:p@localhost:65536/app"))
        .isInstanceOf(IllegalStateException.class)
        .hasMessageContaining("port");
  }

  @Test
  void aDatabaseNameMayContainADot() {
    assertThat(
            DatabaseUrlEnvironmentPostProcessor.toSpringProperties(
                "postgres://u:p@localhost/app.v2"))
        .containsEntry("spring.datasource.url", "jdbc:postgresql://localhost:5432/app.v2");
  }

  @Test
  void aMalformedPercentEscapeIsRefusedWithAClearMessage() {
    assertThatThrownBy(
            () ->
                DatabaseUrlEnvironmentPostProcessor.toSpringProperties(
                    "postgres://u:p%zz@localhost/app"))
        .isInstanceOf(IllegalStateException.class)
        .hasMessageContaining("percent-escape");
  }

  @Test
  void aRawSlashInThePasswordIsRefusedWithAClearMessage() {
    assertThatThrownBy(
            () ->
                DatabaseUrlEnvironmentPostProcessor.toSpringProperties(
                    "postgres://u:pa/ss@localhost/app"))
        .isInstanceOf(IllegalStateException.class)
        .hasMessageContaining("percent-encode");
  }
}
