import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTestApp, type TestApp } from "../helpers/app.js";
import { addDevice, createUser, hlc, mutation, pull, push, type TestDevice } from "../helpers/fixtures.js";

let t: TestApp;
let ada: TestDevice;

beforeEach(async () => {
  t = await buildTestApp();
  ada = await createUser(t);
});

afterEach(async () => {
  await t.close();
});

async function cursorRows(deviceId: string): Promise<number> {
  const result = await t.pool.query("SELECT 1 FROM device_cursors WHERE device_id = $1", [deviceId]);
  return result.rowCount ?? 0;
}

function revoke(by: TestDevice, deviceId: string) {
  return t.app.inject({
    method: "POST",
    url: `/v1/devices/${deviceId}/revoke`,
    headers: { authorization: `Bearer ${by.token}` },
  });
}

describe("revoking a device", () => {
  it("forgets the sync position of a device revoked by another one", async () => {
    const phone = await addDevice(t, ada, "phone");
    await push(t, ada, [mutation({ hlc: hlc(t.clock.now()) })]);
    expect((await pull(t, phone, { after: 1 })).statusCode).toBe(200);
    expect(await cursorRows(phone.deviceId)).toBe(1);

    expect((await revoke(ada, phone.deviceId)).statusCode).toBe(200);
    expect(await cursorRows(phone.deviceId)).toBe(0);
    expect(await cursorRows(ada.deviceId)).toBe(0);
  });

  it("forgets the sync position of a device that revokes itself, and only that one", async () => {
    const phone = await addDevice(t, ada, "phone");
    await pull(t, ada, { after: 0 });
    await pull(t, phone, { after: 0 });
    expect((await revoke(phone, phone.deviceId)).statusCode).toBe(200);
    expect(await cursorRows(phone.deviceId)).toBe(0);
    expect(await cursorRows(ada.deviceId)).toBe(1);
  });
});
