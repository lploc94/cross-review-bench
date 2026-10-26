import type { FastifyInstance } from "fastify";
import type { RouteOptions } from "./types.js";

/** `GET /health`: 200 when the database answers, 503 otherwise. No authentication. */
export async function healthRoutes(app: FastifyInstance, options: RouteOptions): Promise<void> {
  app.get("/health", async (request, reply) => {
    try {
      await options.pool.query("SELECT 1");
      return { status: "ok" };
    } catch (err) {
      request.log.warn({ err }, "health check failed");
      return reply.code(503).send({ status: "unavailable" });
    }
  });
}
