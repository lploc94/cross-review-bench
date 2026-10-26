import { DeviceRevokedError, openDatabase } from "@sync/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openClient, type TestClient } from "../helpers/clients.js";
import { tempDbPath } from "../helpers/tempFiles.js";
import { startTestServer, type TestAccount, type TestServer } from "../helpers/testServer.js";

let server: TestServer;
let laptop: TestAccount;
let phone: TestAccount;
const opened: TestClient[] = [];

beforeEach(async () => {
  server = await startTestServer();
  laptop = await server.createUser("Ada");
  phone = await server.addDevice(laptop);
});

afterEach(async () => {
  for (const c of opened.splice(0)) await c.client.close();
  await server.close();
});

describe("a revoked device whose outbox cannot be cleared", () => {
  it("still rejects the sync with the number of changes that never reached the server", async () => {
    const dbPath = tempDbPath();
    const lost = openClient(server, phone, { dbPath });
    opened.push(lost);
    lost.client.set("notes", "n1", { title: "Quarterly figures" });
    lost.client.set("notes", "n2", { title: "Contacts" });
    lost.client.set("tasks", "t1", { title: "Renew lease" });

    const admin = openClient(server, laptop);
    opened.push(admin);
    await admin.transport.revokeDevice(phone.deviceId);

    const other = openDatabase(dbPath);
    other.exec(`CREATE TRIGGER keep_outbox BEFORE DELETE ON outbox
                BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END`);
    other.close();

    const err = await lost.client.sync().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(DeviceRevokedError);
    expect(err).toMatchObject({ code: "device_revoked", unsynced: 3 });
    expect((err as Error).message).toContain("3 local changes");
    expect(await server.countEvents(laptop.userId)).toBe(0);
  });
});
