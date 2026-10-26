import type { FastifyPluginAsync } from "fastify";
import { authOf, requireScope } from "../plugins/auth.js";
import { createAccountBodySchema } from "../schemas/accounts.js";
import { idParamsSchema, paginationQuerySchema } from "../schemas/common.js";
import {
  serializeAccount,
  serializeEntry,
  serializePage,
} from "../serializers.js";
import { parse } from "../validation.js";
import type { RouteOptions } from "./types.js";

export const accountRoutes: FastifyPluginAsync<RouteOptions> = async (app, { services }) => {
  app.post("/accounts", { preHandler: requireScope("accounts:write") }, async (request, reply) => {
    const { tenantId } = authOf(request);
    const body = parse(createAccountBodySchema, request.body, "body");
    const account = await services.accounts.openAccount(tenantId, body);
    return reply.code(201).send(serializeAccount(account));
  });

  app.get("/accounts", { preHandler: requireScope("accounts:read") }, async (request) => {
    const { tenantId } = authOf(request);
    const page = parse(paginationQuerySchema, request.query, "query");
    return serializePage(await services.accounts.listAccounts(tenantId, page), serializeAccount);
  });

  app.get("/accounts/:id", { preHandler: requireScope("accounts:read") }, async (request) => {
    const { tenantId } = authOf(request);
    const { id } = parse(idParamsSchema, request.params, "params");
    return serializeAccount(await services.accounts.getAccount(tenantId, id));
  });

  app.post(
    "/accounts/:id/close",
    { preHandler: requireScope("accounts:write") },
    async (request) => {
      const { tenantId } = authOf(request);
      const { id } = parse(idParamsSchema, request.params, "params");
      return serializeAccount(await services.accounts.closeAccount(tenantId, id));
    },
  );

  app.get(
    "/accounts/:id/entries",
    { preHandler: requireScope("transfers:read") },
    async (request) => {
      const { tenantId } = authOf(request);
      const { id } = parse(idParamsSchema, request.params, "params");
      const page = parse(paginationQuerySchema, request.query, "query");
      const entries = await services.transfers.listAccountEntries(tenantId, id, page);
      return serializePage(entries, serializeEntry);
    },
  );
};
