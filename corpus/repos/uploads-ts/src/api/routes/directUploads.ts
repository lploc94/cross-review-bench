import multipart from "@fastify/multipart";
import type { FastifyPluginAsync } from "fastify";
import { ValidationError } from "../../domain/errors.js";
import { authOf, requireScope } from "../plugins/auth.js";
import { acceptRawBodies, contentLengthOf, requestBodyStream } from "../requestBody.js";
import { overwriteQuerySchema, wildcardParamsSchema } from "../schemas/common.js";
import { serializeFile } from "../serializers.js";
import { parse } from "../validation.js";
import type { RouteOptions } from "./types.js";

/**
 * Single-request uploads: `PUT /files/<path>` with the raw bytes as the body, and
 * `POST /files` as multipart/form-data with a `path` field followed by one file part.
 * Both answer 201 for a new file and 200 when `overwrite=true` replaced one.
 */
export const directUploadRoutes: FastifyPluginAsync<RouteOptions> = async (app, options) => {
  await app.register(rawUploadRoutes, options);
  await app.register(multipartUploadRoutes, options);
};

const rawUploadRoutes: FastifyPluginAsync<RouteOptions> = async (app, { services }) => {
  acceptRawBodies(app);

  app.put("/files/*", { preHandler: requireScope("files:write") }, async (request, reply) => {
    const { tenantId } = authOf(request);
    const params = parse(wildcardParamsSchema, request.params, "params");
    const { overwrite } = parse(overwriteQuerySchema, request.query, "query");
    const size = contentLengthOf(request);
    const contentType = request.headers["content-type"];
    const outcome = await services.uploads.upload({
      tenantId,
      path: params["*"],
      overwrite,
      body: requestBodyStream(request),
      ...(size === undefined ? {} : { size }),
      ...(contentType === undefined ? {} : { declaredType: contentType }),
    });
    return reply.code(outcome.replaced ? 200 : 201).send(serializeFile(outcome.file));
  });
};

const MAX_FIELD_BYTES = 4096;

const multipartUploadRoutes: FastifyPluginAsync<RouteOptions> = async (app, { services, limits }) => {
  await app.register(multipart, {
    limits: {
      files: 1,
      // One byte over the limit reaches the upload meter, which answers 413; busboy truncating
      // at exactly the limit would otherwise pass a cut-off file as complete.
      fileSize: limits.maxUploadBytes + 1,
      fields: 10,
      fieldSize: MAX_FIELD_BYTES,
      parts: 11,
      headerPairs: 50,
    },
  });

  app.post("/files", { preHandler: requireScope("files:write") }, async (request, reply) => {
    const { tenantId } = authOf(request);
    const { overwrite } = parse(overwriteQuerySchema, request.query, "query");
    if (!request.isMultipart()) {
      throw new ValidationError("POST /v1/files takes multipart/form-data; use PUT for raw bodies");
    }
    // Parts are read in order: the path must be known before the file's bytes start streaming.
    let path: string | null = null;
    for await (const part of request.parts()) {
      if (part.type === "field") {
        if (
          part.fieldname !== "path" ||
          path !== null ||
          typeof part.value !== "string" ||
          part.valueTruncated
        ) {
          throw new ValidationError("the form takes one path field, then one file part");
        }
        path = part.value;
        continue;
      }
      if (path === null) {
        // Drain the file so the error response is not held up by an unread request body.
        part.file.resume();
        throw new ValidationError("the path field must come before the file part");
      }
      const outcome = await services.uploads.upload({
        tenantId,
        path,
        overwrite,
        body: part.file,
        clientFileName: part.filename,
        declaredType: part.mimetype,
      });
      return reply.code(outcome.replaced ? 200 : 201).send(serializeFile(outcome.file));
    }
    throw new ValidationError("the form has no file part");
  });
};
