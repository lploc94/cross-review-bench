import { PROTOCOL_HEADER, PROTOCOL_VERSION } from "@sync/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTestApp, type TestApp } from "../helpers/app.js";
import { createUser, pull, type TestDevice } from "../helpers/fixtures.js";

let t: TestApp;
let device: TestDevice;

beforeEach(async () => {
  t = await buildTestApp();
  device = await createUser(t);
});

afterEach(async () => {
  await t.close();
});

function pullWith(authorization: string | undefined) {
  return t.app.inject({
    method: "GET",
    url: "/v1/sync/pull",
    headers: {
      [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
      ...(authorization === undefined ? {} : { authorization }),
    },
  });
}

describe("device authentication", () => {
  it("accepts the device's token", async () => {
    const res = await pull(t, device);
    expect(res.statusCode).toBe(200);
  });

  it("refuses a request without a token", async () => {
    const res = await pullWith(undefined);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: "unauthorized" } });
  });

  it("refuses a header that is not a bearer token", async () => {
    expect((await pullWith(`Basic ${Buffer.from("a:b").toString("base64")}`)).statusCode).toBe(401);
  });

  it("answers malformed, unknown and wrong tokens alike", async () => {
    const other = await createUser(t, "Grace");
    const wrongSecret = `${device.token.slice(0, 40)}${other.token.slice(40)}`;
    const unknownDevice = device.token.replace(device.deviceId, "00000000-0000-4000-8000-000000000000");
    const answers = await Promise.all(
      ["sd_garbage", wrongSecret, unknownDevice].map(async (token) => (await pullWith(`Bearer ${token}`)).json<unknown>()),
    );
    expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1);
    expect(answers[0]).toMatchObject({ error: { code: "unauthorized" } });
  });

  it("records when the device was last seen, at most once a minute", async () => {
    const lastSeen = async () =>
      (await t.pool.query<{ last_seen_at: Date | null }>("SELECT last_seen_at FROM devices WHERE id = $1", [device.deviceId]))
        .rows[0]?.last_seen_at;
    expect(await lastSeen()).toBeNull();
    await pull(t, device);
    const first = await lastSeen();
    expect(first?.getTime()).toBe(t.clock.now());
    t.clock.advance(30_000);
    await pull(t, device);
    expect((await lastSeen())?.getTime()).toBe(first?.getTime());
    t.clock.advance(30_000);
    await pull(t, device);
    expect((await lastSeen())?.getTime()).toBe(t.clock.now());
  });

  it("protects the account routes too", async () => {
    const res = await t.app.inject({ method: "GET", url: "/v1/devices" });
    expect(res.statusCode).toBe(401);
  });
});
