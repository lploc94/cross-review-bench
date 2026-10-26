import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AccountService } from "../../src/services/accountService.js";
import { buildTestApp, type TestApp } from "../helpers/app.js";
import { addDevice, createUser, pull, type TestDevice } from "../helpers/fixtures.js";

let t: TestApp;
let ada: TestDevice;

beforeEach(async () => {
  t = await buildTestApp();
  ada = await createUser(t);
});

afterEach(async () => {
  await t.close();
});

function request(device: TestDevice, method: "GET" | "POST", url: string, payload?: unknown) {
  return t.app.inject({ method, url, headers: { authorization: `Bearer ${device.token}` }, payload: payload as object });
}

describe("devices", () => {
  it("lists the user's devices with their cursors, marking the caller", async () => {
    const phone = await addDevice(t, ada, "phone");
    await pull(t, phone, { after: 0 });
    const res = await request(phone, "GET", "/v1/devices");
    expect(res.statusCode).toBe(200);
    const devices = res.json<{ data: { id: string; name: string; current: boolean; lastPulledSeq: number | null }[] }>().data;
    expect(devices.map((d) => [d.id, d.name, d.current, d.lastPulledSeq])).toEqual([
      [ada.deviceId, "Ada's laptop", false, null],
      [phone.deviceId, "phone", true, 0],
    ]);
  });

  it("does not show other users' devices", async () => {
    await createUser(t, "Grace");
    const res = await request(ada, "GET", "/v1/devices");
    expect(res.json<{ data: unknown[] }>().data).toHaveLength(1);
  });

  it("registers another device whose token works at once", async () => {
    const res = await request(ada, "POST", "/v1/devices", { name: "  tablet  " });
    expect(res.statusCode).toBe(201);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = res.json<{ device: { id: string; name: string }; token: string }>();
    expect(body.device.name).toBe("tablet");
    const tablet = { userId: ada.userId, deviceId: body.device.id, token: body.token };
    expect((await pull(t, tablet)).statusCode).toBe(200);
  });

  it("rejects invalid device names", async () => {
    for (const payload of [{}, { name: "" }, { name: "x".repeat(101) }, { name: "bell\u0007" }, { name: "ok", extra: 1 }]) {
      expect((await request(ada, "POST", "/v1/devices", payload)).statusCode).toBe(400);
    }
  });

  it("limits the devices of one user", async () => {
    const limited = new AccountService({ pool: t.pool, clock: t.clock, maxDevicesPerUser: 2 });
    await limited.registerDevice(ada.userId, "second");
    await expect(limited.registerDevice(ada.userId, "third")).rejects.toMatchObject({ code: "device_limit" });
  });

  it("tells the caller who it is", async () => {
    const res = await request(ada, "GET", "/v1/me");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      user: { id: ada.userId, displayName: "Ada" },
      device: { id: ada.deviceId, name: "Ada's laptop", lastSeenAt: new Date(t.clock.now()).toISOString() },
    });
  });
});

describe("accounts", () => {
  it("store emails lowercased and refuse a second user with the same email", async () => {
    const created = await t.accounts.createUser({ email: " Lin@Example.TEST ", displayName: "Lin", deviceName: "desk" });
    expect(created.user.email).toBe("lin@example.test");
    await expect(
      t.accounts.createUser({ email: "lin@example.test", displayName: "Other", deviceName: "desk" }),
    ).rejects.toMatchObject({ code: "email_taken" });
  });

  it("validate their input", async () => {
    await expect(
      t.accounts.createUser({ email: "not an email", displayName: "Lin", deviceName: "desk" }),
    ).rejects.toMatchObject({ code: "validation_error" });
    await expect(t.accounts.createUser({ email: "a@example.test", displayName: " ", deviceName: "desk" })).rejects.toMatchObject({
      code: "validation_error",
    });
  });

  it("refuse to register a device for a user that does not exist", async () => {
    await expect(t.accounts.registerDevice("00000000-0000-4000-8000-00000000abcd", "ghost")).rejects.toMatchObject({
      code: "not_found",
    });
  });
});
