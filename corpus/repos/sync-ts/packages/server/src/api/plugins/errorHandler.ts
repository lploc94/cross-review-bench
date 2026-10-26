import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { DomainError, type ErrorDetails } from "../../domain/errors.js";
import { RequestValidationError } from "../validation.js";

export interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: ErrorDetails;
  };
}

function body(code: string, message: string, details?: ErrorDetails): ErrorBody {
  return details === undefined ? { error: { code, message } } : { error: { code, message, details } };
}

function isFastifyClientError(err: unknown): err is FastifyError & { statusCode: number } {
  return (
    err instanceof Error &&
    "statusCode" in err &&
    typeof err.statusCode === "number" &&
    err.statusCode >= 400 &&
    err.statusCode < 500
  );
}

/** Fastify's own 4xx errors (bad JSON, wrong content type, body too large) by status. */
const CLIENT_ERROR_CODES: Record<number, string> = {
  400: "bad_request",
  404: "not_found",
  405: "method_not_allowed",
  406: "not_acceptable",
  413: "payload_too_large",
  415: "unsupported_media_type",
};

/**
 * Map every error to `{ "error": { "code", "message", "details"? } }`: DomainErrors with their
 * own status, request validation errors as 400, fastify's client errors with their status.
 * Anything else is a 500 whose details are logged and never sent to the client.
 */
export function errorHandler(err: unknown, request: FastifyRequest, reply: FastifyReply): FastifyReply {
  if (err instanceof DomainError) {
    if (err.httpStatus >= 500) request.log.error({ err }, "request failed");
    return reply.code(err.httpStatus).send(body(err.code, err.message, err.details));
  }
  if (err instanceof RequestValidationError) {
    return reply.code(400).send(body("validation_error", err.message, err.issues));
  }
  if (isFastifyClientError(err)) {
    const code = CLIENT_ERROR_CODES[err.statusCode] ?? "bad_request";
    return reply.code(err.statusCode).send(body(code, err.message));
  }
  request.log.error({ err }, "unhandled error");
  return reply.code(500).send(body("internal_error", "internal server error"));
}

export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler((request, reply) =>
    reply
      .code(404)
      .send(body("not_found", `route ${request.method} ${request.url.split("?")[0] ?? ""} not found`)),
  );
}
