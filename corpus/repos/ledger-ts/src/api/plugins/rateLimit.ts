import type { FastifyReply, FastifyRequest, onRequestAsyncHookHandler } from "fastify";
import { RateLimitedError } from "../../domain/errors.js";
import type { RateLimiter } from "../../infra/rateLimiter.js";
import { authOf } from "./auth.js";

/**
 * onRequest hook, after authentication: count the request against its API key's per-minute
 * budget and answer 429 with Retry-After once the budget is spent.
 *
 * If Redis cannot be reached the request is let through and the failure logged: losing rate
 * limiting for a while is better than refusing every request.
 */
export function rateLimit(limiter: RateLimiter): onRequestAsyncHookHandler {
  return async function limitRequest(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const auth = authOf(request);
    let decision;
    try {
      decision = await limiter.consume(auth.apiKeyId);
    } catch (err) {
      request.log.error({ err }, "rate limiter unavailable, request allowed");
      return;
    }
    reply.header("x-ratelimit-limit", decision.limit);
    reply.header("x-ratelimit-remaining", decision.remaining);
    reply.header("x-ratelimit-reset", Math.floor(decision.resetAt.getTime() / 1000));
    if (!decision.allowed) {
      throw new RateLimitedError(decision.retryAfterSeconds);
    }
  };
}
