package com.innkeep.booking.support;

import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.classic.spi.IThrowableProxy;
import ch.qos.logback.core.read.ListAppender;
import com.fasterxml.jackson.core.JsonFactory;
import com.fasterxml.jackson.core.JsonGenerator;
import java.io.StringWriter;
import net.logstash.logback.argument.StructuredArgument;
import org.slf4j.LoggerFactory;

/** Captures what a logger writes while an action runs, for asserting what must not be logged. */
public final class LogCapture {

  /** Work whose log lines are captured. */
  public interface Action {
    void run() throws Exception;
  }

  private LogCapture() {}

  /**
   * Runs the action and returns every captured line: the message text, the exception chain with its
   * messages, then the structured arguments as JSON, so a value in any of them can be searched for.
   */
  public static String during(String loggerName, Action action) throws Exception {
    var logger = (Logger) LoggerFactory.getLogger(loggerName);
    var appender = new ListAppender<ILoggingEvent>();
    appender.start();
    logger.addAppender(appender);
    try {
      action.run();
    } finally {
      logger.detachAppender(appender);
    }
    StringBuilder captured = new StringBuilder();
    for (ILoggingEvent event : appender.list) {
      captured.append(event.getFormattedMessage());
      for (IThrowableProxy cause = event.getThrowableProxy();
          cause != null;
          cause = cause.getCause()) {
        captured.append(cause.getClassName()).append(": ").append(cause.getMessage());
      }
      Object[] arguments = event.getArgumentArray();
      if (arguments == null) {
        continue;
      }
      for (Object argument : arguments) {
        if (argument instanceof StructuredArgument structured) {
          captured.append(json(structured));
        }
      }
    }
    return captured.toString();
  }

  private static String json(StructuredArgument argument) throws Exception {
    var writer = new StringWriter();
    try (JsonGenerator generator = new JsonFactory().createGenerator(writer)) {
      generator.writeStartObject();
      argument.writeTo(generator);
      generator.writeEndObject();
    }
    return writer.toString();
  }
}
