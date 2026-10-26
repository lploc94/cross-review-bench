import { PROTOCOL_HEADER, PROTOCOL_VERSION } from "@sync/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTestApp, type TestApp } from "../helpers/app.js";
import { createUser, type TestDevice } from "../helpers/fixtures.js";

let t: TestApp;
let device: TestDevice;

beforeEach(async () => {
  t = await buildTestApp();
  device = await createUser(t);
});

afterEach(async () => {
  await t.close();
});

describe("protocol version", () => {
  it("is required on the sync routes", async () => {
    const res = await t.app.inject({
      method: "GET",
      url: "/v1/sync/pull",
      headers: { authorization: `Bearer ${device.token}` },
    });
    expect(res.statusCode).toBe(426);
    expect(res.json()).toMatchObject({
      error: { code: "protocol_mismatch", details: { serverVersion: PROTOCOL_VERSION, requestedVersion: null } },
    });
  });

  it("must be the server's version", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: "/v1/sync/push",
      headers: { authorization: `Bearer ${device.token}`, [PROTOCOL_HEADER]: String(PROTOCOL_VERSION + 1) },
      payload: { mutations: [] },
    });
    expect(res.statusCode).toBe(426);
    expect(res.json()).toMatchObject({ error: { details: { requestedVersion: PROTOCOL_VERSION + 1 } } });
  });

  it("is checked before the token, so an outdated client learns to upgrade", async () => {
    const res = await t.app.inject({ method: "GET", url: "/v1/sync/pull", headers: { [PROTOCOL_HEADER]: "0" } });
    expect(res.statusCode).toBe(426);
  });

  it("is announced on every answer, errors included", async () => {
    const answers = await Promise.all([
      t.app.inject({ method: "GET", url: "/health" }),
      t.app.inject({ method: "GET", url: "/nowhere" }),
      t.app.inject({ method: "GET", url: "/v1/sync/pull" }),
    ]);
    for (const res of answers) expect(res.headers[PROTOCOL_HEADER]).toBe(String(PROTOCOL_VERSION));
  });

  it("is not needed on the account routes", async () => {
    const res = await t.app.inject({
      method: "GET",
      url: "/v1/devices",
      headers: { authorization: `Bearer ${device.token}` },
    });
    expect(res.statusCode).toBe(200);
  });
});
