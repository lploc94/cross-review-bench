import type { FastifyPluginAsync } from "fastify";
import { authOf, requireScope } from "../plugins/auth.js";
import { idParamsSchema, idempotencyKeySchema } from "../schemas/common.js";
import { createTransferBodySchema, listTransfersQuerySchema } from "../schemas/transfers.js";
import {
  serializePage,
  serializeTransfer,
  serializeTransferWithEntries,
} from "../serializers.js";
import { parse } from "../validation.js";
import type { RouteOptions } from "./types.js";

export const IDEMPOTENT_REPLAY_HEADER = "idempotent-replayed";

export const transferRoutes: FastifyPluginAsync<RouteOptions> = async (app, { services }) => {
  /**
   * Requires an Idempotency-Key header. A retry with the same key and body answers with the
   * original response (and `Idempotent-Replayed: true`); the same key with another body is 409.
   */
  app.post("/transfers", { preHandler: requireScope("transfers:write") }, async (request, reply) => {
    const { tenantId } = authOf(request);
    const idempotencyKey = parse(
      idempotencyKeySchema,
      request.headers["idempotency-key"],
      "headers",
    );
    const body = parse(createTransferBodySchema, request.body, "body");
    const { response, replayed } = await services.transfers.createTransfer({
      tenantId,
      idempotencyKey,
      input: {
        fromAccountId: body.from_account_id,
        toAccountId: body.to_account_id,
        amountMinor: body.amount,
        currency: body.currency,
        description: body.description,
        metadata: body.metadata,
      },
      present: (result) => serializeTransferWithEntries(result.transfer, result.entries),
    });
    return reply
      .code(response.status)
      .header(IDEMPOTENT_REPLAY_HEADER, String(replayed))
      .send(response.body);
  });

  app.get("/transfers", { preHandler: requireScope("transfers:read") }, async (request) => {
    const { tenantId } = authOf(request);
    const query = parse(listTransfersQuerySchema, request.query, "query");
    const page = await services.transfers.listTransfers(
      tenantId,
      {
        accountId: query.account_id,
        createdFrom: query.created_from,
        createdTo: query.created_to,
      },
      { limit: query.limit, offset: query.offset },
    );
    return serializePage(page, serializeTransfer);
  });

  app.get("/transfers/:id", { preHandler: requireScope("transfers:read") }, async (request) => {
    const { tenantId } = authOf(request);
    const { id } = parse(idParamsSchema, request.params, "params");
    const { transfer, entries } = await services.transfers.getTransfer(tenantId, id);
    return serializeTransferWithEntries(transfer, entries);
  });
};
