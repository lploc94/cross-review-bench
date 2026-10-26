import type { CollectionName } from "./collections.js";
import type { FieldWrite } from "./merge.js";

/** A document as applications see it: its id and the fields written so far. */
export interface SyncDocument {
  readonly collection: CollectionName;
  readonly id: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

/**
 * One local change: set some fields of one document. Creating a document is setting its first
 * fields. Every field written by a mutation carries the mutation's timestamp.
 */
export interface Mutation {
  readonly mutationId: string;
  readonly collection: string;
  readonly docId: string;
  readonly op: "set";
  readonly fields: Readonly<Record<string, unknown>>;
  readonly hlc: string;
}

/** The field writes of a mutation, in field-name order so every replica applies them alike. */
export function fieldWritesOf(mutation: Pick<Mutation, "fields" | "hlc">): FieldWrite[] {
  return Object.keys(mutation.fields)
    .sort()
    .map((field) => ({ field, value: mutation.fields[field], hlc: mutation.hlc }));
}

/** `collection/id`, a key for maps of documents. */
export function docKey(collection: string, docId: string): string {
  return `${collection}/${docId}`;
}
