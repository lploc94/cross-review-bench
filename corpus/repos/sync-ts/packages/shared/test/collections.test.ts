import { describe, expect, it } from "vitest";
import {
  COLLECTION_NAMES,
  checkFieldWrites,
  fieldNamesOf,
  isCollectionName,
  isValidFieldValue,
  validateFieldWrites,
} from "../src/core/collections.js";
import { MutationValidationError } from "../src/core/errors.js";

describe("collections", () => {
  it("are notes and tasks", () => {
    expect(COLLECTION_NAMES).toEqual(["notes", "tasks"]);
    expect(isCollectionName("notes")).toBe(true);
    expect(isCollectionName("toString")).toBe(false);
    expect(fieldNamesOf("tasks")).toEqual(["title", "done", "dueDate", "priority", "notes", "noteId"]);
  });

  it("accept any subset of a collection's fields", () => {
    expect(checkFieldWrites("notes", { tags: ["home", "weekly"], color: "green" })).toEqual({
      ok: true,
      fields: { tags: ["home", "weekly"], color: "green" },
    });
    expect(checkFieldWrites("tasks", { dueDate: null, noteId: null, priority: 0 }).ok).toBe(true);
  });

  it("report every bad field", () => {
    const result = checkFieldWrites("tasks", { title: 5, priority: 4, owner: "me" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((i) => i.field).sort()).toEqual(["owner", "priority", "title"]);
    }
  });

  it("reject an unknown collection and an empty write", () => {
    expect(checkFieldWrites("contacts", { title: "x" })).toMatchObject({ ok: false, issues: [{ field: "" }] });
    expect(checkFieldWrites("notes", {})).toMatchObject({ ok: false, issues: [{ field: "" }] });
  });

  it("check dates against the calendar", () => {
    expect(isValidFieldValue("tasks", "dueDate", "2032-02-29")).toBe(true);
    expect(isValidFieldValue("tasks", "dueDate", "2031-02-29")).toBe(false);
    expect(isValidFieldValue("tasks", "dueDate", "2031-13-01")).toBe(false);
    expect(isValidFieldValue("tasks", "dueDate", "2031-1-01")).toBe(false);
    expect(isValidFieldValue("tasks", "dueDate", "2031-01-01T00:00:00Z")).toBe(false);
  });

  it("reject text the databases cannot store", () => {
    expect(isValidFieldValue("notes", "title", "a\u0000b")).toBe(false);
    expect(isValidFieldValue("notes", "title", "lone \ud800 surrogate")).toBe(false);
    expect(isValidFieldValue("notes", "title", "emoji \u{1f600} is fine")).toBe(true);
  });

  it("bound lengths and ranges", () => {
    expect(isValidFieldValue("notes", "title", "x".repeat(200))).toBe(true);
    expect(isValidFieldValue("notes", "title", "x".repeat(201))).toBe(false);
    expect(isValidFieldValue("notes", "tags", Array.from({ length: 21 }, (_, i) => `t${i}`))).toBe(false);
    expect(isValidFieldValue("notes", "tags", [""])).toBe(false);
    expect(isValidFieldValue("tasks", "priority", 1.5)).toBe(false);
    expect(isValidFieldValue("tasks", "priority", -1)).toBe(false);
    expect(isValidFieldValue("tasks", "noteId", "has space")).toBe(false);
  });

  it("do not know fields inherited from Object.prototype", () => {
    expect(isValidFieldValue("notes", "constructor", "x")).toBe(false);
    expect(checkFieldWrites("notes", { toString: "x" }).ok).toBe(false);
  });

  it("throw a MutationValidationError from validateFieldWrites", () => {
    expect(() => validateFieldWrites("notes", { pinned: "yes" })).toThrow(MutationValidationError);
    try {
      validateFieldWrites("notes", { pinned: "yes" });
    } catch (err) {
      expect(err).toMatchObject({ code: "invalid_mutation", retryable: false, issues: [{ field: "pinned" }] });
    }
  });
});
