import type { FastifyPluginAsync } from "fastify";
import { authOf, requireScope } from "../plugins/auth.js";
import { patchTenantBodySchema } from "../schemas/tenant.js";
import { serializeTenant } from "../serializers.js";
import { parse } from "../validation.js";
import type { RouteOptions } from "./types.js";

/** The caller's own tenant: usage, and the quota for keys with `tenant:admin`. */
export const tenantRoutes: FastifyPluginAsync<RouteOptions> = async (app, { services }) => {
  app.get("/tenant", { preHandler: requireScope("tenant:read") }, async (request) => {
    const { tenantId } = authOf(request);
    return serializeTenant(await services.tenants.getTenant(tenantId));
  });

  app.patch("/tenant", { preHandler: requireScope("tenant:admin") }, async (request) => {
    const { tenantId } = authOf(request);
    const body = parse(patchTenantBodySchema, request.body, "body");
    return serializeTenant(await services.tenants.setQuota(tenantId, body.quotaBytes));
  });
};
