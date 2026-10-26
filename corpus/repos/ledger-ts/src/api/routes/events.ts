import type { FastifyPluginAsync } from "fastify";
import { authOf, requireScope } from "../plugins/auth.js";
import { eventParamsSchema, listEventsQuerySchema } from "../schemas/events.js";
import { serializeEvent, serializePage } from "../serializers.js";
import { parse } from "../validation.js";
import type { RouteOptions } from "./types.js";

export const eventRoutes: FastifyPluginAsync<RouteOptions> = async (app, { services }) => {
  const guard = { preHandler: requireScope("webhooks:manage") };

  app.get("/events", guard, async (request) => {
    const { tenantId } = authOf(request);
    const query = parse(listEventsQuerySchema, request.query, "query");
    const page = await services.events.listEvents(
      tenantId,
      {
        eventType: query.type,
        aggregateId: query.aggregate_id,
        createdFrom: query.created_from,
        createdTo: query.created_to,
      },
      { limit: query.limit, offset: query.offset },
    );
    return serializePage(page, serializeEvent);
  });

  app.get("/events/:id", guard, async (request) => {
    const { tenantId } = authOf(request);
    const { id } = parse(eventParamsSchema, request.params, "params");
    return serializeEvent(await services.events.getEvent(tenantId, id));
  });
};
