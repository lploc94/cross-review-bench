import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTestApp, type TestApp } from "../helpers/app.js";
import { addDevice, createUser, hlc, mutation, pull, push, syncHeaders, type TestDevice } from "../helpers/fixtures.js";

let t: TestApp;
let ada: TestDevice;
let phone: TestDevice;

beforeEach(async () => {
  t = await buildTestApp();
  ada = await createUser(t);
  phone = await addDevice(t, ada, "phone");
  expect((await push(t, ada, [mutation({ docId: "n1", fields: { title: "Payroll" }, hlc: hlc(t.clock.now()) })])).statusCode).toBe(200);
  const revoked = await t.app.inject({
    method: "POST",
    url: `/v1/devices/${phone.deviceId}/revoke`,
    headers: { authorization: `Bearer ${ada.token}` },
  });
  expect(revoked.statusCode).toBe(200);
});

afterEach(async () => {
  await t.close();
});

function get(device: TestDevice, url: string) {
  return t.app.inject({ method: "GET", url, headers: syncHeaders(device) });
}

describe("a revoked device's token", () => {
  it("cannot pull the user's change feed", async () => {
    const res = await pull(t, phone, { after: 0 });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: "device_revoked" } });
    expect(res.body).not.toContain("Payroll");
  });

  it("cannot read the sync status, documents or the device list", async () => {
    for (const url of ["/v1/sync/status", "/v1/documents/notes/n1", "/v1/devices"]) {
      const res = await get(phone, url);
      expect(res.statusCode, url).toBe(401);
      expect(res.json(), url).toMatchObject({ error: { code: "device_revoked" } });
    }
  });

  it("still gets its own state from /v1/me, and other devices keep reading", async () => {
    expect((await get(phone, "/v1/me")).statusCode).toBe(200);
    expect((await pull(t, ada, { after: 0 })).statusCode).toBe(200);
    expect((await get(ada, "/v1/documents/notes/n1")).statusCode).toBe(200);
  });
});
