import { z } from "zod";
import { isHlcString } from "./hlc.js";
import { DOC_ID_PATTERN, UUID_PATTERN } from "./ids.js";

/**
 * The wire protocol between clients and the sync server. Every sync request carries the
 * `Sync-Protocol` header with the client's protocol version; the server answers a different or
 * missing version with 426 and its own version, and stamps its version on every answer.
 */
export const PROTOCOL_VERSION = 1;
/** Header name as Node.js presents it (lowercase); clients may send any case. */
export const PROTOCOL_HEADER = "sync-protocol";

/** Server default for the most mutations accepted in one push. */
export const DEFAULT_PUSH_MAX_MUTATIONS = 500;
/** Server default for the largest pull page. */
export const DEFAULT_PULL_MAX_LIMIT = 1_000;

export const hlcSchema = z.string().refine(isHlcString, "must be a hybrid logical clock timestamp");
export const uuidSchema = z.string().regex(UUID_PATTERN, "must be a lowercase UUID");
export const docIdSchema = z
  .string()
  .regex(DOC_ID_PATTERN, "must be 1 to 64 letters, digits, '_' or '-'");
/** Event sequence numbers and cursors: non-negative, and exact in a JavaScript number. */
export const seqSchema = z.int().min(0);

export const mutationSchema = z.strictObject({
  mutationId: uuidSchema,
  collection: z.string().min(1).max(64),
  docId: docIdSchema,
  op: z.literal("set"),
  fields: z.record(z.string(), z.json()),
  hlc: hlcSchema,
});

export const pushRequestSchema = z.strictObject({
  mutations: z.array(mutationSchema).min(1),
});

export const pushResponseSchema = z.object({
  /** Every mutation of the request that the server has now recorded, applied or not. */
  acked: z.array(uuidSchema),
  /** The server's clock after receiving the mutations. */
  serverHlc: hlcSchema,
});

export const pullRequestSchema = z.object({
  /** The last sequence number the client has applied; 0 for none. */
  after: seqSchema,
  limit: z.int().min(1),
});

/** One field write recorded by the server, as clients pull it. */
export const syncEventSchema = z.object({
  seq: z.int().min(1),
  mutationId: uuidSchema,
  deviceId: uuidSchema,
  collection: z.string().min(1),
  docId: docIdSchema,
  field: z.string().min(1),
  value: z.json(),
  hlc: hlcSchema,
  serverReceivedAt: z.iso.datetime({ offset: true }),
});

export const pullResponseSchema = z.object({
  /** Events with `seq > after`, in ascending `seq` order. */
  events: z.array(syncEventSchema),
  /** The `after` of the next request: the last event's seq, or the request's `after`. */
  nextAfter: seqSchema,
  hasMore: z.boolean(),
});

/** Where the calling device stands in its user's change feed. */
export const syncStatusResponseSchema = z.object({
  /** The highest seq of the user's events; 0 before the first event. */
  latestSeq: seqSchema,
  /** The `after` of the device's latest pull, or null before its first pull. */
  cursor: seqSchema.nullable(),
});

/** A device of the user, as the account routes return it. */
export const deviceSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  createdAt: z.iso.datetime({ offset: true }),
  lastSeenAt: z.iso.datetime({ offset: true }).nullable(),
});

/** `GET /v1/me`: the calling device and its user. */
export const meResponseSchema = z.object({
  user: z.object({
    id: uuidSchema,
    email: z.string(),
    displayName: z.string(),
  }),
  device: deviceSchema,
});

/** `POST /v1/devices`: the new device and its token, shown only in this answer. */
export const registerDeviceResponseSchema = z.object({
  device: deviceSchema,
  token: z.string().min(1),
});

export const errorBodySchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});

export type MutationPayload = z.output<typeof mutationSchema>;
export type PushRequest = z.output<typeof pushRequestSchema>;
export type PushResponse = z.output<typeof pushResponseSchema>;
export type PullRequest = z.output<typeof pullRequestSchema>;
export type SyncEvent = z.output<typeof syncEventSchema>;
export type PullResponse = z.output<typeof pullResponseSchema>;
export type SyncStatusResponse = z.output<typeof syncStatusResponseSchema>;
export type DeviceInfo = z.output<typeof deviceSchema>;
export type MeResponse = z.output<typeof meResponseSchema>;
export type RegisterDeviceResponse = z.output<typeof registerDeviceResponseSchema>;
export type ErrorBody = z.output<typeof errorBodySchema>;

/**
 * The protocol version a request declares, or null when the header is missing or is not a
 * single decimal number.
 */
export function parseProtocolVersion(header: string | string[] | undefined): number | null {
  if (typeof header !== "string") return null;
  const trimmed = header.trim();
  if (!/^\d{1,6}$/.test(trimmed)) return null;
  return Number(trimmed);
}
