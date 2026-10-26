import { z } from "zod";
import { MAX_CURSOR_LENGTH } from "../../domain/cursor.js";
import { integerParam } from "./common.js";

/** Default page size of the listing, capped by LIST_MAX_LIMIT. */
export const DEFAULT_LIST_LIMIT = 100;

export function listFilesQuerySchema(maxLimit: number) {
  return z.object({
    after: z.string().min(1).max(MAX_CURSOR_LENGTH).optional(),
    limit: integerParam({ min: 1, max: maxLimit, fallback: Math.min(DEFAULT_LIST_LIMIT, maxLimit) }),
  });
}

export function signedUrlBodySchema(maxTtlSeconds: number) {
  return z.object({
    expiresIn: z.number().int().min(1).max(maxTtlSeconds),
  });
}

export const publicDownloadQuerySchema = z.object({
  exp: z.string().max(32),
  sig: z.string().max(128),
});
