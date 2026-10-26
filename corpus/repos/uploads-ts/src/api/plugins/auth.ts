import type { FastifyReply, FastifyRequest, onRequestAsyncHookHandler } from "fastify";
import { ForbiddenError, UnauthorizedError } from "../../domain/errors.js";
import { hasScope, type Scope } from "../../domain/scopes.js";
import type { ApiKeyService, AuthContext } from "../../services/apiKeyService.js";

declare module "fastify" {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

const BEARER = /^Bearer[ ]+(\S+)[ ]*$/i;

/**
 * onRequest hook for the authenticated API: `Authorization: Bearer up_<prefix>_<secret>`.
 * Unknown, malformed and revoked keys all get the same 401 so a caller learns nothing about
 * which keys exist.
 */
export function authenticate(apiKeys: ApiKeyService): onRequestAsyncHookHandler {
  return async function authenticateRequest(request: FastifyRequest): Promise<void> {
    const header = request.headers.authorization;
    if (header === undefined || header === "") {
      throw new UnauthorizedError("missing Authorization header");
    }
    const token = BEARER.exec(header)?.[1];
    if (token === undefined) {
      throw new UnauthorizedError("the Authorization header must be a Bearer token");
    }
    const auth = await apiKeys.authenticate(token);
    if (!auth) {
      throw new UnauthorizedError("invalid API key");
    }
    request.auth = auth;
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

/**
 * Route-level guard: the API key must hold exactly `scope`. Use as the route's preHandler, after
 * authentication has run in onRequest; it runs before the body of a streamed upload is read.
 */
export function requireScope(scope: Scope) {
  return async function checkScope(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const auth = authOf(request);
    if (!hasScope(auth.scopes, scope)) {
      throw new ForbiddenError(`this API key lacks the ${scope} scope`, { requiredScope: scope });
    }
  };
}
