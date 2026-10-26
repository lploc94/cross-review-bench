package com.innkeep.booking.config;

import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.env.EnvironmentPostProcessor;
import org.springframework.core.env.ConfigurableEnvironment;
import org.springframework.core.env.MapPropertySource;

/**
 * Converts {@code DATABASE_URL} ({@code postgres://user:pass@host:port/db}, libpq style) into the
 * JDBC settings Spring expects. The app and the tests take the same path, so neither assumes a port
 * or a database name.
 */
public class DatabaseUrlEnvironmentPostProcessor implements EnvironmentPostProcessor {

  static final String DATABASE_URL = "DATABASE_URL";
  static final int DEFAULT_PORT = 5432;

  @Override
  public void postProcessEnvironment(ConfigurableEnvironment environment, SpringApplication app) {
    String raw = environment.getProperty(DATABASE_URL);
    if (raw == null || raw.isBlank()) {
      throw new IllegalStateException("DATABASE_URL is not set");
    }
    Map<String, Object> settings = toSpringProperties(raw);
    environment.getPropertySources().addFirst(new MapPropertySource("databaseUrl", settings));
  }

  /** Parses a libpq-style URL into {@code spring.datasource.*} properties. */
  static Map<String, Object> toSpringProperties(String databaseUrl) {
    URI uri = URI.create(databaseUrl.trim());
    String scheme = uri.getScheme();
    if (scheme == null || !(scheme.equals("postgres") || scheme.equals("postgresql"))) {
      throw new IllegalStateException("DATABASE_URL must start with postgres://");
    }
    if (uri.getHost() == null) {
      throw new IllegalStateException(
          databaseUrl.indexOf('@') != databaseUrl.lastIndexOf('@')
              ? "DATABASE_URL has an '@' that is not percent-encoded; write it in the password as %40"
              : "DATABASE_URL has no host");
    }
    String database = uri.getPath() == null ? "" : uri.getPath().replaceFirst("^/", "");
    if (database.isEmpty()) {
      throw new IllegalStateException("DATABASE_URL has no database name");
    }
    int port = uri.getPort() == -1 ? DEFAULT_PORT : uri.getPort();
    StringBuilder jdbc =
        new StringBuilder("jdbc:postgresql://")
            .append(uri.getHost())
            .append(':')
            .append(port)
            .append('/')
            .append(database);
    if (uri.getRawQuery() != null) {
      jdbc.append('?').append(uri.getRawQuery());
    }
    Map<String, Object> settings = new HashMap<>();
    settings.put("spring.datasource.url", jdbc.toString());
    // Split the raw user info at its first colon, then decode each part: an encoded colon belongs
    // to the user name or the password, never to the separator.
    String userInfo = uri.getRawUserInfo();
    if (userInfo != null) {
      int colon = userInfo.indexOf(':');
      settings.put(
          "spring.datasource.username",
          decode(colon < 0 ? userInfo : userInfo.substring(0, colon)));
      if (colon >= 0) {
        settings.put("spring.datasource.password", decode(userInfo.substring(colon + 1)));
      }
    }
    return settings;
  }

  private static String decode(String raw) {
    // URLDecoder reads a plus as a space; in user info a plus is a plus, so escape it first.
    return URLDecoder.decode(raw.replace("+", "%2B"), StandardCharsets.UTF_8);
  }
}
