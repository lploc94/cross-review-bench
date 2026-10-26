import { pino, type DestinationStream, type Logger, type LoggerOptions } from "pino";

export type { Logger };

/** Paths whose values never reach the log output, wherever a request or its headers are logged. */
export const REDACTED_PATHS = [
  "req.headers.authorization",
  "request.headers.authorization",
  "headers.authorization",
  "authorization",
  "*.authorization",
  "token",
  "*.token",
];

const CENSOR = "[redacted]";

interface RequestLike {
  method?: string;
  url?: string;
  hostname?: string;
  ip?: string;
  headers?: Record<string, unknown>;
}

/** What a request contributes to a log line: never its headers or body. */
function serializeRequest(req: RequestLike): Record<string, unknown> {
  return {
    method: req.method,
    url: req.url,
    host: req.hostname,
    remoteAddress: req.ip,
    protocol: req.headers?.["sync-protocol"],
  };
}

function serializeResponse(res: { statusCode?: number }): Record<string, unknown> {
  return { statusCode: res.statusCode };
}

export function createLogger(
  options: { level: string; name?: string },
  destination?: DestinationStream,
): Logger {
  const config: LoggerOptions = {
    name: options.name ?? "sync-server",
    level: options.level,
    redact: { paths: REDACTED_PATHS, censor: CENSOR },
    timestamp: pino.stdTimeFunctions.isoTime,
    serializers: {
      req: serializeRequest,
      res: serializeResponse,
      err: pino.stdSerializers.err,
    },
    formatters: {
      level: (label) => ({ level: label }),
    },
  };
  return destination ? pino(config, destination) : pino(config);
}
