import type { FastifyPluginAsync } from "fastify";
import { authOf, requireScope } from "../plugins/auth.js";
import { idParamsSchema } from "../schemas/common.js";
import {
  captureHoldBodySchema,
  createHoldBodySchema,
  listHoldsQuerySchema,
} from "../schemas/holds.js";
import { serializeHold, serializePage, serializeTransfer } from "../serializers.js";
import { parse } from "../validation.js";
import type { RouteOptions } from "./types.js";

export const holdRoutes: FastifyPluginAsync<RouteOptions> = async (app, { services }) => {
  app.post("/holds", { preHandler: requireScope("holds:write") }, async (request, reply) => {
    const { tenantId } = authOf(request);
    const body = parse(createHoldBodySchema, request.body, "body");
    const hold = await services.holds.createHold(tenantId, {
      accountId: body.account_id,
      amountMinor: body.amount,
      currency: body.currency,
      expiresInSeconds: body.expires_in_seconds,
    });
    return reply.code(201).send(serializeHold(hold));
  });

  app.get("/holds", { preHandler: requireScope("holds:read") }, async (request) => {
    const { tenantId } = authOf(request);
    const query = parse(listHoldsQuerySchema, request.query, "query");
    const page = await services.holds.listHolds(
      tenantId,
      {
        accountId: query.account_id,
        status: query.status,
        createdFrom: query.created_from,
        createdTo: query.created_to,
      },
      { limit: query.limit, offset: query.offset },
    );
    return serializePage(page, serializeHold);
  });

  app.get("/holds/:id", { preHandler: requireScope("holds:read") }, async (request) => {
    const { tenantId } = authOf(request);
    const { id } = parse(idParamsSchema, request.params, "params");
    return serializeHold(await services.holds.getHold(tenantId, id));
  });

  app.post("/holds/:id/capture", { preHandler: requireScope("holds:write") }, async (request) => {
    const { tenantId } = authOf(request);
    const { id } = parse(idParamsSchema, request.params, "params");
    const body = parse(captureHoldBodySchema, request.body, "body");
    const { hold, transfer } = await services.holds.captureHold(tenantId, id, body.to_account_id);
    return { hold: serializeHold(hold), transfer: serializeTransfer(transfer) };
  });

  app.post("/holds/:id/void", { preHandler: requireScope("holds:write") }, async (request) => {
    const { tenantId } = authOf(request);
    const { id } = parse(idParamsSchema, request.params, "params");
    return serializeHold(await services.holds.voidHold(tenantId, id));
  });
};
