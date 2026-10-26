import { HttpError, HttpTransport, InvalidResponseError, NetworkError, ProtocolMismatchError } from "@sync/client";
import { describe, expect, it } from "vitest";

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(answer: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const call = { url: input instanceof Request ? input.url : input.toString(), init: init ?? {} };
    calls.push(call);
    return answer(call);
  };
  return { calls, fetch };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

const TOKEN = "sd_token";
const SERVER_HLC = "001894701600000:00000:server";

describe("HttpTransport", () => {
  it("sends the token and the protocol version under the base path", async () => {
    const { calls, fetch } = fakeFetch(() => json(200, { events: [], nextAfter: 3, hasMore: false }));
    const transport = new HttpTransport({ baseUrl: "https://sync.example.test/api/", token: TOKEN, fetch });
    expect(await transport.pull({ after: 3, limit: 50 })).toEqual({ events: [], nextAfter: 3, hasMore: false });
    expect(calls[0]?.url).toBe("https://sync.example.test/api/v1/sync/pull?after=3&limit=50");
    expect(calls[0]?.init.headers).toMatchObject({ authorization: `Bearer ${TOKEN}`, "sync-protocol": "1" });
  });

  it("posts pushes as JSON", async () => {
    const { calls, fetch } = fakeFetch(() => json(200, { acked: [], serverHlc: SERVER_HLC }));
    const transport = new HttpTransport({ baseUrl: "http://localhost:3000", token: TOKEN, fetch });
    await transport.push({ mutations: [] });
    expect(calls[0]?.url).toBe("http://localhost:3000/v1/sync/push");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.body).toBe('{"mutations":[]}');
  });

  it("turns a failed request into a retryable NetworkError", async () => {
    const { fetch } = fakeFetch(() => {
      throw new TypeError("fetch failed");
    });
    const transport = new HttpTransport({ baseUrl: "http://localhost:3000", token: TOKEN, fetch });
    const err = await transport.pull({ after: 0, limit: 1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect(err).toMatchObject({ retryable: true, code: "network_error" });
  });

  it("marks server errors retryable and client errors not", async () => {
    const answers = [
      json(503, { error: { code: "unavailable", message: "busy" } }),
      new Response("<html>bad gateway</html>", { status: 502 }),
      json(422, { error: { code: "invalid_mutation", message: "bad", details: { index: 2 } } }),
    ];
    const { fetch } = fakeFetch(() => answers.shift() ?? json(500, {}));
    const transport = new HttpTransport({ baseUrl: "http://localhost:3000", token: TOKEN, fetch });
    const errors = [];
    for (let i = 0; i < 3; i++) errors.push(await transport.push({ mutations: [] }).catch((e: unknown) => e));
    expect(errors[0]).toMatchObject({ code: "unavailable", retryable: true, status: 503 });
    expect(errors[1]).toMatchObject({ code: "http_502", retryable: true });
    expect(errors[2]).toBeInstanceOf(HttpError);
    expect(errors[2]).toMatchObject({ code: "invalid_mutation", retryable: false, details: { server: { index: 2 }, status: 422 } });
  });

  it("reports the server's protocol version on 426", async () => {
    const { fetch } = fakeFetch(() =>
      json(426, { error: { code: "protocol_mismatch", message: "upgrade", details: { serverVersion: 2 } } }),
    );
    const transport = new HttpTransport({ baseUrl: "http://localhost:3000", token: TOKEN, fetch });
    const err = await transport.pull({ after: 0, limit: 1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProtocolMismatchError);
    expect(err).toMatchObject({ serverVersion: 2, retryable: false });
  });

  it("reads the version from the header when the body has none", async () => {
    const { fetch } = fakeFetch(() => new Response("upgrade", { status: 426, headers: { "sync-protocol": "3" } }));
    const transport = new HttpTransport({ baseUrl: "http://localhost:3000", token: TOKEN, fetch });
    await expect(transport.pull({ after: 0, limit: 1 })).rejects.toMatchObject({ serverVersion: 3 });
  });

  it("rejects successful answers that break the protocol", async () => {
    const answers = [new Response("not json", { status: 200 }), json(200, { events: "none" })];
    const { fetch } = fakeFetch(() => answers.shift() ?? json(200, {}));
    const transport = new HttpTransport({ baseUrl: "http://localhost:3000", token: TOKEN, fetch });
    await expect(transport.pull({ after: 0, limit: 1 })).rejects.toBeInstanceOf(InvalidResponseError);
    await expect(transport.pull({ after: 0, limit: 1 })).rejects.toMatchObject({ code: "invalid_response", retryable: false });
  });

  it("validates its options", () => {
    expect(() => new HttpTransport({ baseUrl: "ftp://x", token: TOKEN })).toThrow(RangeError);
    expect(() => new HttpTransport({ baseUrl: "http://x?y=1", token: TOKEN })).toThrow(RangeError);
    expect(() => new HttpTransport({ baseUrl: "http://x", token: " " })).toThrow(RangeError);
    expect(() => new HttpTransport({ baseUrl: "http://x", token: TOKEN, timeoutMs: 0 })).toThrow(RangeError);
  });
});
