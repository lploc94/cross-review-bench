import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "../../src/infra/logger.js";
import { ScanWorker } from "../../src/services/scanWorker.js";
import { WEBHOOK_ATTEMPTS, WebhookNotifier, type FileEventNotifier } from "../../src/services/webhooks.js";
import { buildTestApp, type TestApp } from "../helpers/app.js";
import { createTenant, expectStatus, storeFile, type TestTenant } from "../helpers/fixtures.js";
import { WebhookReceiver } from "../helpers/webhookReceiver.js";

/**
 * A receiver that keeps failing must not take the process down: Node 22 exits on an unhandled
 * promise rejection. The worker gets the real notifier behind a thin wrapper that only lets the
 * test know when each delivery has settled; the promise the worker receives is a fresh one, so
 * whether its rejection is handled is decided by the worker alone.
 */
describe("webhook receiver outage", () => {
  let t: TestApp;
  let tenant: TestTenant;
  let receiver: WebhookReceiver;
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };

  beforeEach(async () => {
    unhandled.length = 0;
    process.on("unhandledRejection", onUnhandled);
    t = await buildTestApp({
      env: { WEBHOOK_RETRY_DELAY_MS: "0", WEBHOOK_TIMEOUT_MS: "300", SCAN_BATCH_SIZE: "5" },
    });
    tenant = await createTenant(t.pool, t.clock);
    receiver = await WebhookReceiver.start();
    const response = await t.app.inject({
      method: "PUT",
      url: "/v1/tenant/webhook",
      headers: tenant.headers,
      payload: { url: receiver.url },
    });
    expectStatus(response, 200);
  });

  afterEach(async () => {
    await receiver.close();
    await t.close();
    process.off("unhandledRejection", onUnhandled);
  });

  function worker(): { worker: ScanWorker; settled: Promise<string>[] } {
    const real = new WebhookNotifier({
      pool: t.pool,
      clock: t.clock,
      logger: createLogger({ level: "silent" }),
      settings: t.config.webhooks,
    });
    const settled: Promise<string>[] = [];
    const notifier: FileEventNotifier = {
      fileAvailable(file, at) {
        const delivery = real.fileAvailable(file, at);
        settled.push(delivery.then(() => "delivered", () => "failed"));
        return delivery.then(() => undefined);
      },
    };
    return {
      worker: new ScanWorker({
        pool: t.pool,
        clock: t.clock,
        logger: createLogger({ level: "silent" }),
        storage: t.storage,
        scanner: t.scanner,
        settings: t.config.scan,
        notifier,
      }),
      settled,
    };
  }

  /** Let the event loop finish the current turn, where unhandled rejections are reported. */
  async function afterRejectionsAreReported(): Promise<void> {
    for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
  }

  it("survives a receiver that always fails and keeps processing files", async () => {
    receiver.defaultStatus = 500;
    await storeFile(t.app, tenant, "inbox/a.txt", "first");
    await storeFile(t.app, tenant, "inbox/b.txt", "second");
    const { worker: scan, settled } = worker();

    expect(await scan.runOnce()).toMatchObject({ claimed: 2, available: 2 });
    expect(await Promise.all(settled)).toEqual(["failed", "failed"]);
    await afterRejectionsAreReported();
    expect(receiver.received).toHaveLength(2 * WEBHOOK_ATTEMPTS);
    expect(unhandled).toEqual([]);

    receiver.defaultStatus = 204;
    await storeFile(t.app, tenant, "inbox/c.txt", "third");
    expect(await scan.runOnce()).toMatchObject({ claimed: 1, available: 1 });
    expect(await Promise.all(settled)).toEqual(["failed", "failed", "delivered"]);
    await afterRejectionsAreReported();
    expect(unhandled).toEqual([]);
  });

  it("survives a receiver that never answers", async () => {
    receiver.silent = true;
    await storeFile(t.app, tenant, "inbox/d.txt", "fourth");
    const { worker: scan, settled } = worker();

    expect(await scan.runOnce()).toMatchObject({ claimed: 1, available: 1 });
    expect(await Promise.all(settled)).toEqual(["failed"]);
    await afterRejectionsAreReported();
    expect(unhandled).toEqual([]);
  });
});
