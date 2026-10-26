import type { FastifyInstance } from "fastify";
import { authenticate } from "../plugins/auth.js";
import { requireProtocol } from "../plugins/protocol.js";
import { deviceRoutes } from "./devices.js";
import { documentRoutes } from "./documents.js";
import { healthRoutes } from "./health.js";
import { syncRoutes } from "./sync.js";
import type { RouteOptions } from "./types.js";

/**
 * Every route of the server. `/health` is public; everything under `/v1` needs a device token.
 * The sync routes also need the client's protocol version, checked before the token so an
 * outdated client learns it must upgrade.
 */
export async function registerRoutes(app: FastifyInstance, options: RouteOptions): Promise<void> {
  await app.register(healthRoutes, options);
  await app.register(
    async (v1) => {
      await v1.register(
        async (sync) => {
          sync.addHook("onRequest", requireProtocol());
          sync.addHook("onRequest", authenticate(options.services.auth));
          await sync.register(syncRoutes, options);
        },
        { prefix: "/sync" },
      );
      await v1.register(async (api) => {
        api.addHook("onRequest", authenticate(options.services.auth));
        await api.register(documentRoutes, options);
        await api.register(deviceRoutes, options);
      });
    },
    { prefix: "/v1" },
  );
}
