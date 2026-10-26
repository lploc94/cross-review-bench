import { z } from "zod";

/** Sizes above MAX_UPLOAD_BYTES are refused by the service with 413, like any oversized upload. */
export const createSessionBodySchema = z.object({
  path: z.string().min(1).max(4096),
  size: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  contentType: z.string().min(1).max(255).optional(),
});

/** The `Upload-Offset` header of a chunk: a non-negative decimal integer. */
export const uploadOffsetHeadersSchema = z.object({
  "upload-offset": z
    .string({ error: "the Upload-Offset header is required" })
    .regex(/^\d{1,16}$/, { error: "Upload-Offset must be a non-negative integer" })
    .transform(Number)
    .pipe(z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)),
});
