package com.papertrail.workflow.config;

import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.regex.Pattern;
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

  private static final Pattern HOST = Pattern.compile("[A-Za-z0-9_.-]+");
  private static final Pattern IPV6 = Pattern.compile("\\[[0-9A-Fa-f:.]+\\]");
  private static final Pattern DATABASE = Pattern.compile("[A-Za-z0-9_.-]+");

  /**
   * Parses a libpq-style URL into {@code spring.datasource.*} properties. The same rules as the
   * booking service: the user info is split at its last {@code @}, then at its first raw colon, and
   * each part is percent-decoded with a raw plus kept. A bracketed IPv6 host keeps its brackets. A
   * database name is only the characters the JDBC URL takes unchanged; anything else is refused,
   * not spliced. A raw {@code /} in the user info or a malformed escape is refused with a message
   * that names it.
   */
  static Map<String, Object> toSpringProperties(String databaseUrl) {
    String raw = databaseUrl.trim();
    if (!(raw.startsWith("postgres://") || raw.startsWith("postgresql://"))) {
      throw new IllegalStateException("DATABASE_URL must start with postgres://");
    }
    String rest = raw.substring(raw.indexOf("://") + 3);
    int pathStart = indexOfAny(rest, "/?");
    String authority = pathStart < 0 ? rest : rest.substring(0, pathStart);
    String tail = pathStart < 0 ? "" : rest.substring(pathStart);
    String beforeQuery = tail.contains("?") ? tail.substring(0, tail.indexOf('?')) : tail;
    if (!authority.contains("@") && beforeQuery.contains("@")) {
      throw new IllegalStateException(
          "DATABASE_URL must percent-encode '/' in the user name or password");
    }

    String userInfo = null;
    String hostPort = authority;
    int at = authority.lastIndexOf('@');
    if (at >= 0) {
      userInfo = authority.substring(0, at);
      hostPort = authority.substring(at + 1);
    }

    String host;
    String portText = null;
    if (hostPort.startsWith("[")) {
      int close = hostPort.indexOf(']');
      if (close < 0 || !IPV6.matcher(hostPort.substring(0, close + 1)).matches()) {
        throw new IllegalStateException("DATABASE_URL has no host");
      }
      host = hostPort.substring(0, close + 1);
      String after = hostPort.substring(close + 1);
      if (!after.isEmpty()) {
        if (!after.startsWith(":")) {
          throw new IllegalStateException("DATABASE_URL has an invalid port");
        }
        portText = after.substring(1);
      }
    } else {
      int colon = hostPort.indexOf(':');
      host = colon < 0 ? hostPort : hostPort.substring(0, colon);
      if (colon >= 0) {
        portText = hostPort.substring(colon + 1);
      }
      if (!HOST.matcher(host).matches()) {
        throw new IllegalStateException("DATABASE_URL has no host");
      }
    }
    int port = DEFAULT_PORT;
    if (portText != null) {
      if (!portText.matches("[0-9]{1,5}")) {
        throw new IllegalStateException("DATABASE_URL has an invalid port");
      }
      port = Integer.parseInt(portText);
      if (port < 1 || port > 65535) {
        throw new IllegalStateException("DATABASE_URL has an invalid port");
      }
    }

    String query = null;
    String path = tail;
    int question = tail.indexOf('?');
    if (question >= 0) {
      path = tail.substring(0, question);
      query = tail.substring(question + 1);
    }
    if (!path.startsWith("/") || path.length() < 2) {
      throw new IllegalStateException("DATABASE_URL has no database name");
    }
    String database = path.substring(1);
    if (!DATABASE.matcher(database).matches()) {
      throw new IllegalStateException(
          "the database name in DATABASE_URL has characters that are not allowed");
    }

    StringBuilder jdbc =
        new StringBuilder("jdbc:postgresql://")
            .append(host)
            .append(':')
            .append(port)
            .append('/')
            .append(database);
    if (query != null) {
      jdbc.append('?').append(query);
    }
    Map<String, Object> settings = new HashMap<>();
    settings.put("spring.datasource.url", jdbc.toString());
    if (userInfo != null) {
      int separator = userInfo.indexOf(':');
      String user = separator < 0 ? userInfo : userInfo.substring(0, separator);
      settings.put("spring.datasource.username", decode(user));
      if (separator >= 0) {
        settings.put("spring.datasource.password", decode(userInfo.substring(separator + 1)));
      }
    }
    return settings;
  }

  private static int indexOfAny(String text, String chars) {
    for (int i = 0; i < text.length(); i++) {
      if (chars.indexOf(text.charAt(i)) >= 0) {
        return i;
      }
    }
    return -1;
  }

  /** Percent-decodes one part; a raw plus is a plus, not a space. */
  private static String decode(String part) {
    try {
      return URLDecoder.decode(part.replace("+", "%2B"), StandardCharsets.UTF_8);
    } catch (IllegalArgumentException e) {
      throw new IllegalStateException(
          "DATABASE_URL has a malformed percent-escape in the user name or password");
    }
  }
}
