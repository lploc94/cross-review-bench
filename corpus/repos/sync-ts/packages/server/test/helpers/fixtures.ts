import {
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  formatHlc,
  type HlcTimestamp,
  type MutationPayload,
} from "@sync/shared";
import type { LightMyRequestResponse } from "fastify";
import type { TestApp } from "./app.js";

export interface TestDevice {
  readonly userId: string;
  readonly deviceId: string;
  readonly token: string;
}

let counter = 0;

/** A new user with a first device. */
export async function createUser(t: TestApp, name = "Ada"): Promise<TestDevice> {
  counter += 1;
  const created = await t.accounts.createUser({
    email: `${name.toLowerCase()}.${counter}@example.test`,
    displayName: name,
    deviceName: `${name}'s laptop`,
  });
  return { userId: created.user.id, deviceId: created.device.id, token: created.token };
}

/**
 * Another device of the same user, registered one millisecond after the previous one so that
 * device lists (ordered by creation time, then id) come out in registration order.
 */
export async function addDevice(t: TestApp, user: TestDevice, name = "phone"): Promise<TestDevice> {
  t.clock.advance(1);
  const registered = await t.accounts.registerDevice(user.userId, name);
  return { userId: user.userId, deviceId: registered.device.id, token: registered.token };
}

export function syncHeaders(device: TestDevice): Record<string, string> {
  return { authorization: `Bearer ${device.token}`, [PROTOCOL_HEADER]: String(PROTOCOL_VERSION) };
}

let mutationCounter = 0;

/** A lowercase v4 UUID that is unique within the test run. */
export function nextUuid(): string {
  mutationCounter += 1;
  return `00000000-0000-4000-8000-${mutationCounter.toString(16).padStart(12, "0")}`;
}

/** Canonical HLC string; wall defaults to the manual clock's start. */
export function hlc(wallMs: number, counter = 0, node = "device-a"): string {
  const ts: HlcTimestamp = { wallMs, counter, node };
  return formatHlc(ts);
}

export function mutation(overrides: Partial<MutationPayload> & { hlc: string }): MutationPayload {
  return {
    mutationId: nextUuid(),
    collection: "notes",
    docId: "note-1",
    op: "set",
    fields: { title: "Groceries" },
    ...overrides,
  };
}

export async function push(
  t: TestApp,
  device: TestDevice,
  /** Usually MutationPayload[]; anything else tests the validation of the body. */
  mutations: unknown,
): Promise<LightMyRequestResponse> {
  return t.app.inject({
    method: "POST",
    url: "/v1/sync/push",
    headers: syncHeaders(device),
    payload: { mutations },
  });
}

export async function pull(
  t: TestApp,
  device: TestDevice,
  query: { after?: number | string; limit?: number | string } = {},
): Promise<LightMyRequestResponse> {
  const params = new URLSearchParams();
  if (query.after !== undefined) params.set("after", String(query.after));
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  const qs = params.toString();
  return t.app.inject({
    method: "GET",
    url: `/v1/sync/pull${qs ? `?${qs}` : ""}`,
    headers: syncHeaders(device),
  });
}
