import { PROTOCOL_HEADER, PROTOCOL_VERSION, parseProtocolVersion } from "@sync/shared";
import type { FastifyInstance, FastifyRequest, onRequestAsyncHookHandler } from "fastify";
import { ProtocolMismatchError } from "../../domain/errors.js";

/** Every answer, errors included, tells the client which protocol version the server speaks. */
export function announceProtocol(app: FastifyInstance): void {
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header(PROTOCOL_HEADER, String(PROTOCOL_VERSION));
    return payload;
  });
}

/** onRequest hook of the sync routes: the request must declare the server's protocol version. */
export function requireProtocol(): onRequestAsyncHookHandler {
  return async function checkProtocol(request: FastifyRequest): Promise<void> {
    const requested = parseProtocolVersion(request.headers[PROTOCOL_HEADER]);
    if (requested !== PROTOCOL_VERSION) {
      throw new ProtocolMismatchError(PROTOCOL_VERSION, requested);
    }
  };
}
