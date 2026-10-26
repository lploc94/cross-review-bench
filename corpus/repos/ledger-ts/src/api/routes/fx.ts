import type { FastifyPluginAsync } from "fastify";
import { authOf, requireScope } from "../plugins/auth.js";
import { quoteQuerySchema, rateParamsSchema } from "../schemas/fx.js";
import { serializeQuote, serializeRate } from "../serializers.js";
import { parse } from "../validation.js";
import type { RouteOptions } from "./types.js";

export const fxRoutes: FastifyPluginAsync<RouteOptions> = async (app, { services }) => {
  app.get("/fx/rates/:base/:quote", { preHandler: requireScope("fx:read") }, async (request) => {
    const { tenantId } = authOf(request);
    const { base, quote } = parse(rateParamsSchema, request.params, "params");
    return serializeRate(await services.fx.getRate(tenantId, base, quote));
  });

  app.get("/fx/quote", { preHandler: requireScope("fx:read") }, async (request) => {
    const { tenantId } = authOf(request);
    const query = parse(quoteQuerySchema, request.query, "query");
    return serializeQuote(await services.fx.quote(tenantId, query.from, query.to, query.amount));
  });
};
