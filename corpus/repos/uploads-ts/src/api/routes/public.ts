import type { FastifyPluginAsync } from "fastify";
import { idParamsSchema } from "../schemas/common.js";
import { publicDownloadQuerySchema } from "../schemas/files.js";
import { parse } from "../validation.js";
import { sendFile } from "./sendFile.js";
import type { RouteOptions } from "./types.js";

/** Downloads through signed links: no Authorization header, the signature is the authority. */
export const publicRoutes: FastifyPluginAsync<RouteOptions> = async (app, { services }) => {
  app.get("/public/:id", async (request, reply) => {
    const { id } = parse(idParamsSchema, request.params, "params");
    const { exp, sig } = parse(publicDownloadQuerySchema, request.query, "query");
    const file = await services.files.resolveSignedDownload(id, exp, sig);
    return sendFile(request, reply, services.files, file);
  });
};
