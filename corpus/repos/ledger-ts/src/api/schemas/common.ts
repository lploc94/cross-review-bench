import { z } from "zod";
import { isCurrencyCode } from "../../domain/currency.js";
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from "../../domain/pagination.js";
import { MAX_AMOUNT_MINOR } from "../../domain/money.js";

/** Resource ids: UUIDs in any letter case, normalized to lowercase as Postgres prints them. */
export const idSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/, {
    error: "must be a UUID",
  })
  .transform((value) => value.toLowerCase());

export const idParamsSchema = z.object({ id: idSchema });

export const currencySchema = z
  .string()
  .refine(isCurrencyCode, { error: "must be a supported ISO 4217 currency code" });

/**
 * A positive amount in minor units as a decimal integer string ("1050" is 10.50 USD). Strings,
 * not JSON numbers, so that no amount ever passes through a double.
 */
export const amountSchema = z
  .string()
  .regex(/^[1-9]\d{0,17}$/, { error: "must be a positive integer string of minor units" })
  .transform((value) => BigInt(value))
  .refine((value) => value <= MAX_AMOUNT_MINOR, {
    error: `must not exceed ${MAX_AMOUNT_MINOR}`,
  });

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

/** `limit` (1…100, default 25) and `offset` (default 0) for offset-paginated lists. */
export const paginationQuerySchema = z.object({
  limit: integerParam({ min: 1, max: MAX_PAGE_LIMIT, fallback: DEFAULT_PAGE_LIMIT }),
  offset: integerParam({ min: 0, max: 1_000_000, fallback: 0 }),
});

const timestampSchema = z
  .string()
  .pipe(z.iso.datetime({ offset: true, error: "must be an ISO 8601 timestamp with a time zone" }))
  .transform((value) => new Date(value));

/**
 * A half-open time range on created_at, shared by every list that filters by creation time:
 *
 *   created_from <= created_at < created_to
 *
 * `created_from` is inclusive and `created_to` is exclusive, so consecutive ranges such as
 * [00:00, 01:00) and [01:00, 02:00) cover every instant exactly once. Either bound may be left out.
 */
export const createdRangeSchema = z
  .object({
    created_from: timestampSchema.optional(),
    created_to: timestampSchema.optional(),
  })
  .refine(
    (range) =>
      range.created_from === undefined ||
      range.created_to === undefined ||
      range.created_from.getTime() < range.created_to.getTime(),
    { error: "created_from must be before created_to", path: ["created_to"] },
  );

/** Free-form string labels attached to a transfer: up to 20 keys. */
export const metadataSchema = z
  .record(
    z.string().min(1).max(40).regex(/^[A-Za-z0-9_.-]+$/, { error: "invalid metadata key" }),
    z.string().max(500),
  )
  .refine((value) => Object.keys(value).length <= 20, {
    error: "must have at most 20 keys",
  });

/** Idempotency keys: 1 to 255 visible ASCII characters (a UUID is the usual choice). */
export const idempotencyKeySchema = z
  .string({ error: "the Idempotency-Key header is required" })
  .regex(/^[\x21-\x7e]{1,255}$/, {
    error: "Idempotency-Key must be 1 to 255 visible ASCII characters",
  });

/**
 * Text Postgres can store in text and jsonb: no NUL character and no unpaired surrogate (a lone
 * surrogate is not valid UTF-8, and jsonb rejects its escape).
 */
const UNPAIRED_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
export const storableText = (value: string): boolean =>
  !value.includes("\u0000") && !UNPAIRED_SURROGATE.test(value);
export const STORABLE_TEXT_MESSAGE = "must not contain NUL characters or unpaired surrogates";
