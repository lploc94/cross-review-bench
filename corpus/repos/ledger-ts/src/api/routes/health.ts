import type { FastifyPluginAsync } from "fastify";

/** Liveness only: the process is up and serving. It does not touch Postgres or Redis. */
export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get("/health/live", async () => ({ status: "ok" }));
};
