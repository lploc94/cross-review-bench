import { describe, expect, it } from "vitest";
import { formatHlc } from "../src/core/hlc.js";
import {
  parseProtocolVersion,
  pullResponseSchema,
  pushRequestSchema,
  pushResponseSchema,
} from "../src/core/protocol.js";

const hlc = formatHlc({ wallMs: 1_894_701_600_000, counter: 0, node: "n1" });
const mutation = {
  mutationId: "6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f",
  collection: "notes",
  docId: "note-1",
  op: "set",
  fields: { title: "x" },
  hlc,
};

describe("protocol schemas", () => {
  it("accept a valid push", () => {
    expect(pushRequestSchema.safeParse({ mutations: [mutation] }).success).toBe(true);
  });

  it("reject a push with a missing field value or a non-JSON value", () => {
    expect(pushRequestSchema.safeParse({ mutations: [{ ...mutation, fields: { title: undefined } }] }).success).toBe(false);
    expect(pushRequestSchema.safeParse({ mutations: [{ ...mutation, fields: { title: Number.NaN } }] }).success).toBe(false);
  });

  it("require lowercase mutation ids", () => {
    const upper = { ...mutation, mutationId: mutation.mutationId.toUpperCase() };
    expect(pushRequestSchema.safeParse({ mutations: [upper] }).success).toBe(false);
    expect(pushResponseSchema.safeParse({ acked: [upper.mutationId], serverHlc: hlc }).success).toBe(false);
  });

  it("validate pulled events", () => {
    const event = {
      seq: 1,
      mutationId: mutation.mutationId,
      deviceId: mutation.mutationId,
      collection: "notes",
      docId: "note-1",
      field: "title",
      value: ["a"],
      hlc,
      serverReceivedAt: "2030-01-15T10:00:00.000Z",
    };
    expect(pullResponseSchema.safeParse({ events: [event], nextAfter: 1, hasMore: false }).success).toBe(true);
    expect(pullResponseSchema.safeParse({ events: [{ ...event, seq: 0 }], nextAfter: 1, hasMore: false }).success).toBe(false);
    expect(pullResponseSchema.safeParse({ events: [], nextAfter: -1, hasMore: false }).success).toBe(false);
  });
});

describe("parseProtocolVersion", () => {
  it("reads a single decimal number", () => {
    expect(parseProtocolVersion("1")).toBe(1);
    expect(parseProtocolVersion(" 2 ")).toBe(2);
  });

  it("returns null for anything else", () => {
    for (const header of [undefined, "", "v1", "1.0", "-1", ["1", "1"]]) {
      expect(parseProtocolVersion(header)).toBeNull();
    }
  });
});
