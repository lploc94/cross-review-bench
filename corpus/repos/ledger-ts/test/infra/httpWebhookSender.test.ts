import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { HttpWebhookSender } from "../../src/infra/httpWebhookSender.js";
import { WebhookDeliveryError } from "../../src/services/webhookSender.js";

interface Received {
  method: string | undefined;
  headers: IncomingMessage["headers"];
  body: string;
}

let server: Server | undefined;

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  server = createServer(handler);
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}/hook`;
}

async function closeServer(): Promise<void> {
  const current = server;
  server = undefined;
  if (!current?.listening) return;
  current.closeAllConnections();
  await new Promise((resolve) => current.close(resolve));
}

afterEach(closeServer);

const delivery = (url: string) => ({
  endpointId: "endpoint-1",
  url,
  body: '{"id":"1"}',
  headers: { "x-ledger-signature": "t=1,v1=00" },
});

describe("HttpWebhookSender", () => {
  it("POSTs the body and headers as JSON", async () => {
    const received: Received[] = [];
    const url = await listen((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString()));
      req.on("end", () => {
        received.push({ method: req.method, headers: req.headers, body });
        res.writeHead(204).end();
      });
    });
    await new HttpWebhookSender({ timeoutMs: 5000 }).send(delivery(url));
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      method: "POST",
      body: '{"id":"1"}',
      headers: { "content-type": "application/json", "x-ledger-signature": "t=1,v1=00" },
    });
  });

  it("fails on a non-2xx answer, redirects included", async () => {
    for (const status of [500, 302]) {
      const url = await listen((_req, res) => {
        res.writeHead(status, { location: "http://127.0.0.1:1/elsewhere" }).end();
      });
      const error = await new HttpWebhookSender({ timeoutMs: 5000 })
        .send(delivery(url))
        .catch((err: unknown) => err);
      expect(error).toBeInstanceOf(WebhookDeliveryError);
      expect((error as WebhookDeliveryError).status).toBe(status);
      await closeServer();
    }
  });

  it("gives up after the timeout", async () => {
    const url = await listen(() => {
      // never answers
    });
    await expect(new HttpWebhookSender({ timeoutMs: 100 }).send(delivery(url))).rejects.toThrow(
      /timed out after 100 ms/,
    );
  });

  it("reports connection failures", async () => {
    const url = await listen((_req, res) => res.end());
    await closeServer();
    await expect(new HttpWebhookSender({ timeoutMs: 1000 }).send(delivery(url))).rejects.toBeInstanceOf(
      WebhookDeliveryError,
    );
  });
});
