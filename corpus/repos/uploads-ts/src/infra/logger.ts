import { pino, type DestinationStream, type Logger, type LoggerOptions } from "pino";

export type { Logger };

/** Paths whose values never reach the log output, wherever a request or its headers are logged. */
export const REDACTED_PATHS = [
  "req.headers.authorization",
  "request.headers.authorization",
  "headers.authorization",
  "authorization",
  "*.authorization",
  "sig",
  "*.sig",
  "query.sig",
  "req.query.sig",
  "secret",
  "*.secret",
  "token",
  "*.token",
];

const CENSOR = "[redacted]";

/**
 * A URL with the value of every `sig` query parameter replaced, so signed download links cannot be
 * replayed from the logs.
 */
export function redactUrl(url: string): string {
  const queryStart = url.indexOf("?");
  if (queryStart < 0) return url;
  const query = url
    .slice(queryStart + 1)
    .split("&")
    .map((pair) => (/^sig(=|$)/i.test(pair) ? `sig=${CENSOR}` : pair))
    .join("&");
  return `${url.slice(0, queryStart)}?${query}`;
}

interface RequestLike {
  method?: string;
  url?: string;
  host?: string;
  hostname?: string;
  ip?: string;
  socket?: { remoteAddress?: string; remotePort?: number } | null;
  headers?: Record<string, unknown>;
}

/** What a request contributes to a log line: never its headers, and its URL without signatures. */
function serializeRequest(req: RequestLike): Record<string, unknown> {
  return {
    method: req.method,
    url: typeof req.url === "string" ? redactUrl(req.url) : req.url,
    host: req.host ?? req.hostname,
    remoteAddress: req.ip ?? req.socket?.remoteAddress,
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
    name: options.name ?? "uploads",
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
