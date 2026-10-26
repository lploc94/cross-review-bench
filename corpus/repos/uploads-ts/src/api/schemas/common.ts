import { z } from "zod";

/** Resource ids: UUIDs in any letter case, normalized to lowercase as Postgres prints them. */
export const idSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/, {
    error: "must be a UUID",
  })
  .transform((value) => value.toLowerCase());

export const idParamsSchema = z.object({ id: idSchema });

/** The rest of the URL after `/v1/files/`: a file path, decoded by the router. */
export const wildcardParamsSchema = z.object({ "*": z.string() });

/** An integer query-string parameter: digits only, so "", "1e3" and "0x10" are rejected. */
export function integerParam(options: { min: number; max: number; fallback: number }) {
  return z
    .string()
    .regex(/^\d{1,9}$/, { error: "must be a non-negative integer" })
    .transform(Number)
    .pipe(z.number().int().min(options.min).max(options.max))
    .optional()
    .transform((value) => value ?? options.fallback);
}

/** A boolean query-string flag: `true` or `false`, absent meaning false. */
export const booleanParam = z
  .enum(["true", "false"], { error: "must be true or false" })
  .optional()
  .transform((value) => value === "true");

export const overwriteQuerySchema = z.object({ overwrite: booleanParam });
