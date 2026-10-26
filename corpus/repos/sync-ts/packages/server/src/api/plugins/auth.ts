import type { FastifyRequest, onRequestAsyncHookHandler } from "fastify";
import type { AuthContext } from "../../domain/accounts.js";
import { UnauthorizedError } from "../../domain/errors.js";
import type { AuthService } from "../../services/authService.js";

declare module "fastify" {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

const BEARER = /^Bearer[ ]+(\S+)[ ]*$/i;

/**
 * onRequest hook of the authenticated API: `Authorization: Bearer <device token>`. Malformed,
 * unknown and wrong tokens all get the same 401, so a caller learns nothing about which devices
 * exist.
 */
export function authenticate(auth: AuthService): onRequestAsyncHookHandler {
  return async function authenticateRequest(request: FastifyRequest): Promise<void> {
    const header = request.headers.authorization;
    if (header === undefined || header === "") {
      throw new UnauthorizedError("missing Authorization header");
    }
    const token = BEARER.exec(header)?.[1];
    if (token === undefined) {
      throw new UnauthorizedError("the Authorization header must be a Bearer token");
    }
    const context = await auth.authenticate(token);
    if (!context) throw new UnauthorizedError("invalid device token");
    request.auth = context;
  };
}

/** The caller of an authenticated route. */
export function authOf(request: FastifyRequest): AuthContext {
  if (!request.auth) {
    // Routes that read the caller are only registered behind `authenticate`.
    throw new UnauthorizedError("request is not authenticated");
  }
  return request.auth;
}
