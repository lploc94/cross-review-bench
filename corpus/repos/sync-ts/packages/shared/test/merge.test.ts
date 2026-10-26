import { describe, expect, it } from "vitest";
import { MutationValidationError } from "../src/core/errors.js";
import { formatHlc } from "../src/core/hlc.js";
import {
  EMPTY_DOC_STATE,
  latestHlc,
  mergeWrites,
  writeWins,
  type DocState,
  type FieldWrite,
} from "../src/core/merge.js";
import { fieldWritesOf } from "../src/core/documents.js";

const T0 = 1_894_701_600_000;
const at = (offset: number, node = "a", counter = 0) => formatHlc({ wallMs: T0 + offset, counter, node });

function write(field: string, value: unknown, hlc: string): FieldWrite {
  return { field, value, hlc };
}

/** A state as a string that does not depend on the order fields were first set. */
function canonical(state: DocState): string {
  const sorted = (record: Readonly<Record<string, unknown>>) =>
    Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : 1)));
  return JSON.stringify({ fields: sorted(state.fields), fieldHlcs: sorted(state.fieldHlcs) });
}

/** Every permutation of `items`. */
function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [items.slice()];
  return items.flatMap((item, i) =>
    permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]),
  );
}

describe("mergeWrites", () => {
  it("sets fields of an empty document", () => {
    const result = mergeWrites(EMPTY_DOC_STATE, [write("title", "Hello", at(1)), write("pinned", true, at(1))]);
    expect(result.state).toEqual({
      fields: { title: "Hello", pinned: true },
      fieldHlcs: { title: at(1), pinned: at(1) },
    });
    expect(result.applied).toHaveLength(2);
    expect(result.skipped).toHaveLength(0);
  });

  it("keeps the value with the greater timestamp", () => {
    const state = mergeWrites(EMPTY_DOC_STATE, [write("title", "new", at(10))]).state;
    const older = mergeWrites(state, [write("title", "old", at(5))]);
    expect(older.state.fields.title).toBe("new");
    expect(older.skipped).toHaveLength(1);
    const newer = mergeWrites(state, [write("title", "newest", at(11))]);
    expect(newer.state.fields.title).toBe("newest");
  });

  it("does not apply a write with the stored timestamp again", () => {
    const state = mergeWrites(EMPTY_DOC_STATE, [write("title", "x", at(1))]).state;
    expect(mergeWrites(state, [write("title", "x", at(1))]).applied).toHaveLength(0);
  });

  it("resolves fields independently", () => {
    const state = mergeWrites(EMPTY_DOC_STATE, [write("title", "t1", at(10)), write("body", "b1", at(1))]).state;
    const result = mergeWrites(state, [write("title", "t2", at(5)), write("body", "b2", at(5))]);
    expect(result.state.fields).toEqual({ title: "t1", body: "b2" });
  });

  it("converges whatever order the writes arrive in", () => {
    const writes = [
      write("title", "a", at(3, "node-a")),
      write("title", "b", at(3, "node-b")),
      write("title", "c", at(2, "node-c", 9)),
      write("body", "x", at(1)),
      write("body", "y", at(1, "a", 1)),
    ];
    const outcomes = new Set(
      permutations(writes).map((order) => canonical(mergeWrites(EMPTY_DOC_STATE, order).state)),
    );
    expect(outcomes.size).toBe(1);
    const [only] = [...outcomes];
    expect(JSON.parse(only ?? "{}")).toMatchObject({ fields: { title: "b", body: "y" } });
  });

  it("does not modify the state it is given", () => {
    const state = mergeWrites(EMPTY_DOC_STATE, [write("title", "x", at(1))]).state;
    const snapshot = JSON.stringify(state);
    mergeWrites(state, [write("title", "y", at(2))]);
    expect(JSON.stringify(state)).toBe(snapshot);
  });

  it("refuses field names that are not identifiers", () => {
    for (const field of ["__proto__", "constructor ", "", "Title", "a.b"]) {
      expect(() => mergeWrites(EMPTY_DOC_STATE, [write(field, 1, at(1))])).toThrow(MutationValidationError);
    }
  });

  it("does not take inherited properties for stored timestamps", () => {
    expect(mergeWrites(EMPTY_DOC_STATE, [write("constructor", "x", at(1))]).applied).toHaveLength(1);
  });
});

describe("helpers", () => {
  it("writeWins treats an unset field as older than any write", () => {
    expect(writeWins(undefined, at(0))).toBe(true);
    expect(writeWins(at(1), at(0))).toBe(false);
  });

  it("latestHlc finds the newest field timestamp", () => {
    const state = mergeWrites(EMPTY_DOC_STATE, [write("title", "x", at(5)), write("body", "y", at(9))]).state;
    expect(latestHlc(state)).toBe(at(9));
    expect(latestHlc(EMPTY_DOC_STATE)).toBeUndefined();
  });

  it("fieldWritesOf stamps each field with the mutation's timestamp, in name order", () => {
    expect(fieldWritesOf({ fields: { title: "t", body: "b" }, hlc: at(1) })).toEqual([
      { field: "body", value: "b", hlc: at(1) },
      { field: "title", value: "t", hlc: at(1) },
    ]);
  });
});
