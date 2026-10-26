import { pino, type Logger, type LoggerOptions } from "pino";

export type { Logger };

/** Paths whose values never reach the log output, wherever a request or its headers are logged. */
export const REDACTED_PATHS = [
  "req.headers.authorization",
  "request.headers.authorization",
  "headers.authorization",
  "authorization",
  "*.authorization",
  "secret",
  "*.secret",
];

export function createLogger(options: { level: string; name?: string }): Logger {
  const config: LoggerOptions = {
    name: options.name ?? "ledger",
    level: options.level,
    redact: { paths: REDACTED_PATHS, censor: "[redacted]" },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
  };
  return pino(config);
}
