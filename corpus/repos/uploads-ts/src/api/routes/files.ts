import type { FastifyPluginAsync } from "fastify";
import { authOf, requireScope } from "../plugins/auth.js";
import { idParamsSchema, wildcardParamsSchema } from "../schemas/common.js";
import { listFilesQuerySchema, signedUrlBodySchema } from "../schemas/files.js";
import { serializeFile } from "../serializers.js";
import { parse } from "../validation.js";
import { sendFile } from "./sendFile.js";
import type { RouteOptions } from "./types.js";

/** Listing, metadata, downloads, deletion and signed links of stored files. */
export const fileRoutes: FastifyPluginAsync<RouteOptions> = async (app, { services, limits }) => {
  const listQuery = listFilesQuerySchema(limits.listMaxLimit);
  const signedUrlBody = signedUrlBodySchema(limits.signedUrlMaxTtlSeconds);

  app.get("/files", { preHandler: requireScope("files:read") }, async (request) => {
    const { tenantId } = authOf(request);
    const query = parse(listQuery, request.query, "query");
    const page = await services.files.list(
      tenantId,
      query.after === undefined ? { limit: query.limit } : { after: query.after, limit: query.limit },
    );
    return { data: page.items.map(serializeFile), nextCursor: page.nextCursor };
  });

  app.get("/files/by-id/:id/meta", { preHandler: requireScope("files:read") }, async (request) => {
    const { tenantId } = authOf(request);
    const { id } = parse(idParamsSchema, request.params, "params");
    return serializeFile(await services.files.getById(tenantId, id));
  });

  app.get("/files/by-id/:id", { preHandler: requireScope("files:read") }, async (request, reply) => {
    const { tenantId } = authOf(request);
    const { id } = parse(idParamsSchema, request.params, "params");
    return sendFile(request, reply, services.files, await services.files.getById(tenantId, id));
  });

  app.post(
    "/files/by-id/:id/signed-url",
    { preHandler: requireScope("files:read") },
    async (request) => {
      const { tenantId } = authOf(request);
      const { id } = parse(idParamsSchema, request.params, "params");
      const body = parse(signedUrlBody, request.body, "body");
      const signed = await services.files.createSignedUrl(tenantId, id, body.expiresIn);
      return { url: signed.url, expiresAt: signed.expiresAt.toISOString() };
    },
  );

  app.get("/files/*", { preHandler: requireScope("files:read") }, async (request, reply) => {
    const { tenantId } = authOf(request);
    const params = parse(wildcardParamsSchema, request.params, "params");
    return sendFile(request, reply, services.files, await services.files.getByPath(tenantId, params["*"]));
  });

  app.delete("/files/*", { preHandler: requireScope("files:delete") }, async (request, reply) => {
    const { tenantId } = authOf(request);
    const params = parse(wildcardParamsSchema, request.params, "params");
    await services.files.deleteByPath(tenantId, params["*"]);
    return reply.code(204).send();
  });
};
