import type { PullResponse, PushResponse, SyncStatusResponse } from "@sync/shared";
import type { FastifyInstance } from "fastify";
import { authOf } from "../plugins/auth.js";
import { pullQuerySchema, pushBodySchema } from "../schemas/sync.js";
import { serializeEvent } from "../serializers.js";
import { parse } from "../validation.js";
import type { RouteOptions } from "./types.js";

/** `/v1/sync`: push local mutations, pull the change feed, see how far behind the device is. */
export async function syncRoutes(app: FastifyInstance, options: RouteOptions): Promise<void> {
  const { push, pull } = options.services;
  const pushBody = pushBodySchema(options.limits.pushMaxMutations);
  const pullQuery = pullQuerySchema({
    maxLimit: options.limits.pullMaxLimit,
    defaultLimit: options.limits.pullDefaultLimit,
  });

  app.post("/push", async (request): Promise<PushResponse> => {
    const auth = authOf(request);
    const body = parse(pushBody, request.body, "body");
    const result = await push.push(auth, body.mutations);
    return { acked: result.acked, serverHlc: result.serverHlc };
  });

  app.get("/pull", async (request): Promise<PullResponse> => {
    const auth = authOf(request);
    const query = parse(pullQuery, request.query, "query");
    const page = await pull.pull(auth, query.after, query.limit);
    return { events: page.events.map(serializeEvent), nextAfter: page.nextAfter, hasMore: page.hasMore };
  });

  app.get("/status", async (request): Promise<SyncStatusResponse> => {
    const status = await pull.status(authOf(request));
    return { latestSeq: status.latestSeq, cursor: status.cursor };
  });
}
