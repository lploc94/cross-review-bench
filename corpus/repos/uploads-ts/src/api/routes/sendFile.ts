import type { FastifyReply, FastifyRequest } from "fastify";
import { etagOf, ifNoneMatchHits, type FileRecord } from "../../domain/file.js";
import type { FileService } from "../../services/fileService.js";
import { contentDisposition } from "../contentDisposition.js";

/**
 * Answer with a file's bytes: its stored (sniffed) type, length and sha256 entity tag, always as
 * an attachment that browsers must not sniff. A matching If-None-Match answers 304 without
 * touching storage. Files that are not available (pending scan, quarantined) are 409.
 */
export async function sendFile(
  request: FastifyRequest,
  reply: FastifyReply,
  files: FileService,
  file: FileRecord,
): Promise<FastifyReply> {
  files.assertDownloadable(file);
  const etag = etagOf(file);
  reply
    .header("etag", etag)
    .header("cache-control", "private")
    .header("x-content-type-options", "nosniff");
  if (ifNoneMatchHits(request.headers["if-none-match"], etag)) {
    return reply.code(304).send();
  }
  const stream = await files.openContent(file);
  return reply
    .header("content-type", file.contentType)
    .header("content-length", String(file.size))
    .header("content-disposition", contentDisposition(file.originalName))
    .send(stream);
}
