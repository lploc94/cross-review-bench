import { WireTransport, type WireRequest, type WireResponse } from "@sync/client";
import type { ServerApp } from "./testServer.js";

/** A request the test transport saw, and what became of it. */
export interface LoggedRequest {
  readonly method: string;
  readonly path: string;
  readonly outcome: number | "failed" | "dropped";
}

/** A request held until the test releases it. */
export interface Gate {
  /** Resolves when the held request has reached the transport. */
  readonly reached: Promise<void>;
  release(): void;
}

type Fault =
  | { readonly kind: "fail"; readonly error: Error }
  | { readonly kind: "drop" }
  | { readonly kind: "hold"; readonly arrived: () => void; readonly released: Promise<void> };

/**
 * The sync protocol over `app.inject`: requests reach the real server in process. Faults are
 * queued and consumed one per request, in order:
 * - `failNext()`: the request never reaches the server (a refused connection);
 * - `dropNextResponse()`: the server processes the request, then the answer is lost;
 * - `holdNext()`: the request waits until the test releases it.
 */
export class InjectTransport extends WireTransport {
  readonly log: LoggedRequest[] = [];
  private readonly app: ServerApp;
  private readonly faults: Fault[] = [];

  constructor(app: ServerApp, token: string) {
    super({ token });
    this.app = app;
  }

  failNext(error: Error = new Error("connect ECONNREFUSED")): this {
    this.faults.push({ kind: "fail", error });
    return this;
  }

  dropNextResponse(): this {
    this.faults.push({ kind: "drop" });
    return this;
  }

  holdNext(): Gate {
    let arrived!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.faults.push({ kind: "hold", arrived, released });
    return { reached, release };
  }

  /** Requests to `path` (without query) seen so far. */
  count(path: string): number {
    return this.log.filter((entry) => entry.path === path).length;
  }

  protected async exchange(request: WireRequest): Promise<WireResponse> {
    const path = request.path.split("?")[0] ?? request.path;
    const fault = this.faults.shift();
    if (fault?.kind === "fail") {
      this.log.push({ method: request.method, path, outcome: "failed" });
      throw fault.error;
    }
    if (fault?.kind === "hold") {
      fault.arrived();
      await fault.released;
    }
    const response = await this.app.inject({
      method: request.method,
      url: request.path,
      headers: { ...request.headers },
      ...(request.body === undefined ? {} : { payload: request.body }),
    });
    if (fault?.kind === "drop") {
      this.log.push({ method: request.method, path, outcome: "dropped" });
      throw new Error("socket hang up");
    }
    this.log.push({ method: request.method, path, outcome: response.statusCode });
    return {
      status: response.statusCode,
      header: (name) => {
        const value = response.headers[name.toLowerCase()];
        return value === undefined ? undefined : String(value);
      },
      body: response.body,
    };
  }
}
