import {
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  SyncError,
  errorBodySchema,
  parseProtocolVersion,
  pullResponseSchema,
  meResponseSchema,
  pushResponseSchema,
  registerDeviceResponseSchema,
  syncStatusResponseSchema,
  type PullRequest,
  type PullResponse,
  type PushRequest,
  type MeResponse,
  type PushResponse,
  type RegisterDeviceResponse,
  type SyncStatusResponse,
} from "@sync/shared";
import type { z } from "zod";
import { HttpError, InvalidResponseError, NetworkError, ProtocolMismatchError } from "./errors.js";
import type { SyncTransport } from "./transport.js";

export interface WireRequest {
  readonly method: "GET" | "POST";
  /** Path and query, starting with `/`. */
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}

export interface WireResponse {
  readonly status: number;
  /** A response header by lowercase name. */
  header(name: string): string | undefined;
  readonly body: string;
}

export const PUSH_PATH = "/v1/sync/push";
export const PULL_PATH = "/v1/sync/pull";
export const STATUS_PATH = "/v1/sync/status";
export const ME_PATH = "/v1/me";
export const DEVICES_PATH = "/v1/devices";

/**
 * The sync protocol over request/response exchanges: request encoding, authentication and
 * protocol headers, and the mapping of answers to results or SyncErrors. Subclasses only move
 * bytes (`exchange`): over fetch for HttpTransport, in-process in tests.
 */
export abstract class WireTransport implements SyncTransport {
  private readonly token: string;

  protected constructor(options: { token: string }) {
    if (options.token.trim() === "") throw new RangeError("a device token is required");
    this.token = options.token;
  }

  /** Send one request. Throw (anything) when no answer arrived; it becomes a NetworkError. */
  protected abstract exchange(request: WireRequest): Promise<WireResponse>;

  async push(request: PushRequest): Promise<PushResponse> {
    const response = await this.send({
      method: "POST",
      path: PUSH_PATH,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    return decode(response, pushResponseSchema);
  }

  async pull(request: PullRequest): Promise<PullResponse> {
    const query = new URLSearchParams({ after: String(request.after), limit: String(request.limit) });
    const response = await this.send({ method: "GET", path: `${PULL_PATH}?${query.toString()}`, headers: {} });
    return decode(response, pullResponseSchema);
  }

  /** The device's position in its user's change feed (not part of a sync). */
  async status(): Promise<SyncStatusResponse> {
    const response = await this.send({ method: "GET", path: STATUS_PATH, headers: {} });
    return decode(response, syncStatusResponseSchema);
  }

  /** The device this transport authenticates as, and its user. */
  async me(): Promise<MeResponse> {
    return decode(await this.send({ method: "GET", path: ME_PATH, headers: {} }), meResponseSchema);
  }

  /** Register another device of the same user; the answer holds its token, shown only once. */
  async registerDevice(name: string): Promise<RegisterDeviceResponse> {
    const response = await this.send({
      method: "POST",
      path: DEVICES_PATH,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    return decode(response, registerDeviceResponseSchema);
  }

  private async send(request: WireRequest): Promise<WireResponse> {
    const headers = {
      ...request.headers,
      accept: "application/json",
      authorization: `Bearer ${this.token}`,
      [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
    };
    try {
      return await this.exchange({ ...request, headers });
    } catch (err) {
      if (err instanceof SyncError) throw err;
      throw new NetworkError(`${request.method} ${request.path.split("?")[0]} failed: ${describe(err)}`, {
        cause: err,
      });
    }
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/** The result of a 2xx answer, or the SyncError an error answer stands for. */
export function decode<S extends z.ZodType>(response: WireResponse, schema: S): z.output<S> {
  if (response.status < 200 || response.status >= 300) throw errorFromResponse(response);
  const json = parseJson(response.body);
  if (json === undefined) {
    throw new InvalidResponseError(`the server answered ${response.status} with a body that is not JSON`);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new InvalidResponseError("the server's answer does not follow the protocol", {
      cause: parsed.error,
      details: { issues: parsed.error.issues.map((i) => `${i.path.map(String).join(".")}: ${i.message}`) },
    });
  }
  return parsed.data;
}

/** Map an error answer to a SyncError; `retryable` follows the status. */
export function errorFromResponse(response: WireResponse): SyncError {
  const parsed = errorBodySchema.safeParse(parseJson(response.body));
  const error = parsed.success ? parsed.data.error : null;
  const message = error?.message ?? `the server answered ${response.status}`;
  if (response.status === 426) {
    const details = error?.details;
    const fromBody =
      details !== null && typeof details === "object" && "serverVersion" in details && typeof details.serverVersion === "number"
        ? details.serverVersion
        : null;
    return new ProtocolMismatchError(message, fromBody ?? parseProtocolVersion(response.header(PROTOCOL_HEADER)));
  }
  const details =
    error?.details !== undefined && error.details !== null && typeof error.details === "object"
      ? { server: error.details }
      : undefined;
  return new HttpError(response.status, error?.code ?? `http_${response.status}`, message, details);
}
