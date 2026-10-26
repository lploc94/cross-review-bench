import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTestApp, type TestApp } from "../helpers/app.js";

let t: TestApp;

beforeEach(async () => {
  t = await buildTestApp();
});

afterEach(async () => {
  await t.close();
});

describe("GET /health", () => {
  it("answers ok when the database answers", async () => {
    const res = await t.app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("answers unknown routes with the error shape", async () => {
    const res = await t.app.inject({ method: "GET", url: "/v2/anything?x=1" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: "not_found", message: "route GET /v2/anything not found" } });
  });
});
