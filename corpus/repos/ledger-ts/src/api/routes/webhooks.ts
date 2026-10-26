import type { FastifyPluginAsync } from "fastify";
import { authOf, requireScope } from "../plugins/auth.js";
import { idParamsSchema } from "../schemas/common.js";
import { createWebhookBodySchema } from "../schemas/webhooks.js";
import { serializeWebhookEndpoint } from "../serializers.js";
import { parse } from "../validation.js";
import type { RouteOptions } from "./types.js";

export const webhookRoutes: FastifyPluginAsync<RouteOptions> = async (app, { services }) => {
  const guard = { preHandler: requireScope("webhooks:manage") };

  app.post("/webhooks", guard, async (request, reply) => {
    const { tenantId } = authOf(request);
    const body = parse(createWebhookBodySchema, request.body, "body");
    const endpoint = await services.webhooks.createEndpoint(tenantId, body.url);
    return reply.code(201).send(serializeWebhookEndpoint(endpoint, { includeSecret: true }));
  });

  app.get("/webhooks", guard, async (request) => {
    const { tenantId } = authOf(request);
    const endpoints = await services.webhooks.listEndpoints(tenantId);
    return { data: endpoints.map((endpoint) => serializeWebhookEndpoint(endpoint)) };
  });

  app.delete("/webhooks/:id", guard, async (request, reply) => {
    const { tenantId } = authOf(request);
    const { id } = parse(idParamsSchema, request.params, "params");
    await services.webhooks.deleteEndpoint(tenantId, id);
    return reply.code(204).send();
  });
};
