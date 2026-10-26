import { mutationSchema } from "@sync/shared";
import { z } from "zod";

/** A decimal integer in a query string, within [min, max]. */
const queryInteger = (min: number, max: number) =>
  z
    .string()
    .regex(/^\d{1,16}$/, "must be a non-negative integer")
    .transform(Number)
    .pipe(z.int().min(min).max(max));

/** `POST /v1/sync/push` body: 1 to `maxMutations` mutations. */
export function pushBodySchema(maxMutations: number) {
  return z.strictObject({
    mutations: z
      .array(mutationSchema)
      .min(1, "at least one mutation is required")
      .max(maxMutations, `at most ${maxMutations} mutations per push`),
  });
}

/** `GET /v1/sync/pull` query: `after` defaults to 0, `limit` to the configured default. */
export function pullQuerySchema(limits: { maxLimit: number; defaultLimit: number }) {
  return z.object({
    after: queryInteger(0, Number.MAX_SAFE_INTEGER).default(0),
    limit: queryInteger(1, limits.maxLimit).default(limits.defaultLimit),
  });
}
