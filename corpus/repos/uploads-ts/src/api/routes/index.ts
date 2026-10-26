import type { FastifyInstance } from "fastify";
import { authenticate } from "../plugins/auth.js";
import { directUploadRoutes } from "./directUploads.js";
import { fileRoutes } from "./files.js";
import { healthRoutes } from "./health.js";
import { publicRoutes } from "./public.js";
import { resumableRoutes } from "./resumable.js";
import { tenantRoutes } from "./tenant.js";
import type { RouteOptions } from "./types.js";

/**
 * Every route of the service. Health checks and signed downloads are public; everything else
 * under /v1 sits behind API-key authentication, and each route checks its own scope.
 */
export async function registerRoutes(app: FastifyInstance, options: RouteOptions): Promise<void> {
  await app.register(healthRoutes, options);
  await app.register(publicRoutes, { ...options, prefix: "/v1" });
  await app.register(
    async (api) => {
      api.addHook("onRequest", authenticate(options.services.apiKeys));
      await api.register(fileRoutes, options);
      await api.register(directUploadRoutes, options);
      await api.register(resumableRoutes, options);
      await api.register(tenantRoutes, options);
    },
    { prefix: "/v1" },
  );
}
