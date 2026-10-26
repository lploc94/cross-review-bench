import { WireTransport, type WireRequest, type WireResponse } from "./wire.js";

export interface HttpTransportOptions {
  /** The server's origin and optional path prefix, e.g. `https://sync.example.com/api`. */
  readonly baseUrl: string;
  readonly token: string;
  /** Longest wait for a whole answer, body included. */
  readonly timeoutMs?: number;
  /** The fetch implementation; the global one by default. */
  readonly fetch?: typeof globalThis.fetch;
}

export const DEFAULT_HTTP_TIMEOUT_MS = 30_000;

/** The sync protocol over HTTP with fetch. */
export class HttpTransport extends WireTransport {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: HttpTransportOptions) {
    super({ token: options.token });
    const url = new URL(options.baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new RangeError(`baseUrl must be an http or https URL, got ${options.baseUrl}`);
    }
    if (url.search !== "" || url.hash !== "") {
      throw new RangeError("baseUrl must not have a query or a fragment");
    }
    // Requests append `/v1/…` to the prefix, so `https://host/api` keeps its `/api`.
    this.baseUrl = url.href.replace(/\/+$/, "");
    const timeoutMs = options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError(`timeoutMs must be a positive integer, got ${timeoutMs}`);
    }
    this.timeoutMs = timeoutMs;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  protected async exchange(request: WireRequest): Promise<WireResponse> {
    const response = await this.fetchImpl(`${this.baseUrl}${request.path}`, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const body = await response.text();
    return {
      status: response.status,
      header: (name) => response.headers.get(name) ?? undefined,
      body,
    };
  }
}
