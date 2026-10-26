import { PassThrough, Readable } from "node:stream";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { ValidationError } from "../domain/errors.js";

/**
 * Hand request bodies to the route as unparsed streams, whatever their content type, in the
 * plugin scope this is called on. Other scopes keep the JSON parser.
 */
export function acceptRawBodies(scope: FastifyInstance): void {
  scope.removeAllContentTypeParsers();
  scope.addContentTypeParser("*", (_request, payload, done) => {
    done(null, payload);
  });
}

/**
 * The body of a raw-body request as a stream the services may destroy. Destroying it detaches it
 * from the connection and lets the rest of the body drain, so an error response (413, 409, …)
 * still reaches the client instead of the connection being reset.
 */
export function requestBodyStream(request: FastifyRequest): Readable {
  const source = request.body;
  if (!(source instanceof Readable)) {
    // No body at all (no Content-Length, no Transfer-Encoding): an empty one.
    return Readable.from([]);
  }
  const body = new PassThrough();
  source.pipe(body);
  source.once("error", (err) => body.destroy(err));
  body.once("close", () => {
    source.unpipe(body);
    if (!source.readableEnded) source.resume();
  });
  return body;
}

/** The announced body length, or undefined for a body of unknown length (chunked). */
export function contentLengthOf(request: FastifyRequest): number | undefined {
  const header = request.headers["content-length"];
  if (header === undefined) return undefined;
  if (!/^\d{1,16}$/.test(header)) throw new ValidationError("invalid Content-Length");
  return Number(header);
}
