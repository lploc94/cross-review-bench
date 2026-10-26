import type { FastifyPluginAsync, FastifyReply } from "fastify";
import type { UploadSession } from "../../domain/uploadSession.js";
import { authOf, requireScope } from "../plugins/auth.js";
import { acceptRawBodies, contentLengthOf, requestBodyStream } from "../requestBody.js";
import { idParamsSchema, overwriteQuerySchema } from "../schemas/common.js";
import { createSessionBodySchema, uploadOffsetHeadersSchema } from "../schemas/uploads.js";
import { serializeFile, serializeSession } from "../serializers.js";
import { parse } from "../validation.js";
import type { RouteOptions } from "./types.js";

function progressHeaders(reply: FastifyReply, session: UploadSession): FastifyReply {
  return reply
    .header("upload-offset", String(session.offset))
    .header("upload-length", String(session.size))
    .header("upload-expires", session.expiresAt.toISOString())
    .header("cache-control", "no-store");
}

/**
 * Resumable uploads:
 *
 *   POST   /uploads              {path, size, contentType?}  → 201 session (Location header)
 *   PATCH  /uploads/:id          Upload-Offset + chunk bytes → 204, new Upload-Offset
 *   HEAD   /uploads/:id                                      → 200, Upload-Offset
 *   POST   /uploads/:id/complete                             → 201 file (200 if it replaced one)
 *   DELETE /uploads/:id                                      → 204
 */
export const resumableRoutes: FastifyPluginAsync<RouteOptions> = async (app, options) => {
  const { services } = options;
  const write = { preHandler: requireScope("uploads:write") };

  app.post("/uploads", write, async (request, reply) => {
    const { tenantId } = authOf(request);
    const { overwrite } = parse(overwriteQuerySchema, request.query, "query");
    const body = parse(createSessionBodySchema, request.body, "body");
    const session = await services.resumable.createSession({
      tenantId,
      path: body.path,
      size: body.size,
      overwrite,
      ...(body.contentType === undefined ? {} : { contentType: body.contentType }),
    });
    return progressHeaders(reply, session)
      .header("location", `/v1/uploads/${session.id}`)
      .code(201)
      .send(serializeSession(session));
  });

  app.head("/uploads/:id", write, async (request, reply) => {
    const { tenantId } = authOf(request);
    const { id } = parse(idParamsSchema, request.params, "params");
    const session = await services.resumable.getOpenSession(tenantId, id);
    return progressHeaders(reply, session).code(200).send();
  });

  app.post("/uploads/:id/complete", write, async (request, reply) => {
    const { tenantId } = authOf(request);
    const { id } = parse(idParamsSchema, request.params, "params");
    const outcome = await services.resumable.complete(tenantId, id);
    return reply.code(outcome.replaced ? 200 : 201).send(serializeFile(outcome.file));
  });

  app.delete("/uploads/:id", write, async (request, reply) => {
    const { tenantId } = authOf(request);
    const { id } = parse(idParamsSchema, request.params, "params");
    await services.resumable.abort(tenantId, id);
    return reply.code(204).send();
  });

  // Chunks arrive as raw bytes of any content type, so they get a scope of their own.
  await app.register(async (raw) => {
    acceptRawBodies(raw);
    raw.patch("/uploads/:id", write, async (request, reply) => {
      const { tenantId } = authOf(request);
      const { id } = parse(idParamsSchema, request.params, "params");
      const headers = parse(uploadOffsetHeadersSchema, request.headers, "headers");
      const size = contentLengthOf(request);
      const session = await services.resumable.appendChunk({
        tenantId,
        sessionId: id,
        offset: headers["upload-offset"],
        body: requestBodyStream(request),
        ...(size === undefined ? {} : { size }),
      });
      return progressHeaders(reply, session).code(204).send();
    });
  });
};
