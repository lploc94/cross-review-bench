import type { FastifyPluginAsync } from "fastify";
import type { RouteOptions } from "./types.js";

/** Liveness (the process answers) and readiness (the database answers). No authentication. */
export const healthRoutes: FastifyPluginAsync<RouteOptions> = async (app, { pool }) => {
  app.get("/health/live", async () => ({ status: "ok" }));

  app.get("/health/ready", async (request, reply) => {
    try {
      await pool.query("SELECT 1");
      return { status: "ok" };
    } catch (err) {
      request.log.warn({ err }, "readiness check failed");
      return reply.code(503).send({ status: "unavailable" });
    }
  });
};
