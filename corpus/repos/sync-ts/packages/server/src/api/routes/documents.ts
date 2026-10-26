import type { FastifyInstance } from "fastify";
import { authOf } from "../plugins/auth.js";
import { documentParamsSchema } from "../schemas/documents.js";
import { serializeDocument } from "../serializers.js";
import { parse } from "../validation.js";
import type { RouteOptions } from "./types.js";

/** `/v1/documents`: the server's materialised state of one document. */
export async function documentRoutes(app: FastifyInstance, options: RouteOptions): Promise<void> {
  const { documents } = options.services;

  app.get("/documents/:collection/:id", async (request) => {
    const auth = authOf(request);
    const params = parse(documentParamsSchema, request.params, "params");
    return serializeDocument(await documents.get(auth, params.collection, params.id));
  });
}
