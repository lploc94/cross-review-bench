import { z } from "zod";
import { DOC_ID_PATTERN } from "./ids.js";
import { MutationValidationError, type FieldIssue } from "./errors.js";

/**
 * The document collections and the type of each of their fields. A document is a set of fields
 * written one by one: any subset of a collection's fields can be set in one mutation, and a field
 * that was never set is absent from the document.
 */

/**
 * Text that PostgreSQL's jsonb and SQLite both store unchanged: no NUL character, no lone UTF-16
 * surrogate. `max` counts UTF-16 code units, as String#length does.
 */
export function text(max: number) {
  return z
    .string()
    .max(max)
    .refine((value) => !value.includes("\u0000"), "must not contain NUL characters")
    .refine((value) => value.isWellFormed(), "must be well-formed Unicode");
}

/** A calendar date `YYYY-MM-DD` that exists (no February 30th). */
export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be a date as YYYY-MM-DD")
  .refine((value) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }, "must be a valid calendar date");

export const NOTE_COLORS = ["none", "red", "orange", "yellow", "green", "blue", "purple"] as const;

const noteFields = {
  title: text(200),
  body: text(8_000),
  pinned: z.boolean(),
  tags: z.array(text(40).min(1)).max(20),
  color: z.enum(NOTE_COLORS),
};

const taskFields = {
  title: text(200),
  done: z.boolean(),
  /** The day the task is due, in the user's calendar; null when it has no due date. */
  dueDate: isoDate.nullable(),
  /** 0 (none) to 3 (high). */
  priority: z.int().min(0).max(3),
  notes: text(4_000),
  /** The note this task belongs to, if any. */
  noteId: z.string().regex(DOC_ID_PATTERN).nullable(),
};

export const COLLECTIONS = {
  notes: noteFields,
  tasks: taskFields,
} as const;

export type CollectionName = keyof typeof COLLECTIONS;
export const COLLECTION_NAMES = Object.keys(COLLECTIONS) as CollectionName[];

export type NoteFields = z.output<z.ZodObject<typeof noteFields>>;
export type TaskFields = z.output<z.ZodObject<typeof taskFields>>;

/** The fields a document of the collection can have; all optional, as a document is built up. */
export type FieldsOf<C extends CollectionName> = C extends "notes"
  ? Partial<NoteFields>
  : C extends "tasks"
    ? Partial<TaskFields>
    : never;

export function isCollectionName(name: string): name is CollectionName {
  return Object.hasOwn(COLLECTIONS, name);
}

export function fieldNamesOf(collection: CollectionName): string[] {
  return Object.keys(COLLECTIONS[collection]);
}

function fieldSchema(collection: CollectionName, field: string): z.ZodType | undefined {
  const shape: Record<string, z.ZodType> = COLLECTIONS[collection];
  return Object.hasOwn(shape, field) ? shape[field] : undefined;
}

export type FieldCheck =
  | { readonly ok: true; readonly fields: Record<string, unknown> }
  | { readonly ok: false; readonly issues: FieldIssue[] };

/**
 * Check the field writes of one mutation: the collection must exist, at least one field must be
 * written, and every field must belong to the collection and hold a value of its type. Returns
 * the parsed values (zod output) or every issue found.
 */
export function checkFieldWrites(collection: string, fields: Record<string, unknown>): FieldCheck {
  if (!isCollectionName(collection)) {
    return { ok: false, issues: [{ field: "", message: `unknown collection ${JSON.stringify(collection)}` }] };
  }
  const names = Object.keys(fields);
  if (names.length === 0) {
    return { ok: false, issues: [{ field: "", message: "at least one field must be set" }] };
  }
  const issues: FieldIssue[] = [];
  const parsed: Record<string, unknown> = {};
  for (const name of names) {
    const schema = fieldSchema(collection, name);
    if (!schema) {
      issues.push({ field: name, message: `unknown field of ${collection}` });
      continue;
    }
    const result = schema.safeParse(fields[name]);
    if (result.success) {
      parsed[name] = result.data;
    } else {
      for (const issue of result.error.issues) {
        const at = issue.path.length > 0 ? ` (at ${issue.path.map(String).join(".")})` : "";
        issues.push({ field: name, message: `${issue.message}${at}` });
      }
    }
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, fields: parsed };
}

/** checkFieldWrites that throws a MutationValidationError listing the issues. */
export function validateFieldWrites(
  collection: string,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const result = checkFieldWrites(collection, fields);
  if (!result.ok) {
    const first = result.issues[0];
    const summary = first ? (first.field ? `${first.field}: ${first.message}` : first.message) : "invalid";
    throw new MutationValidationError(`invalid ${collection} write: ${summary}`, result.issues);
  }
  return result.fields;
}

/** Whether `value` is a valid value of one field of the collection. */
export function isValidFieldValue(collection: CollectionName, field: string, value: unknown): boolean {
  const schema = fieldSchema(collection, field);
  return schema !== undefined && schema.safeParse(value).success;
}
