import type { CollectionName, FieldsOf } from "@sync/shared";
import { UsageError } from "./args.js";

/**
 * How a `field=value` argument is read for each field. The table is typed against the
 * collections, so a field added to a collection without a kind here does not compile.
 */
type Kind = "text" | "boolean" | "integer" | "list" | "nullableText";

const KINDS: { readonly [C in CollectionName]: { readonly [F in keyof Required<FieldsOf<C>>]: Kind } } = {
  notes: { title: "text", body: "text", pinned: "boolean", tags: "list", color: "text" },
  tasks: {
    title: "text",
    done: "boolean",
    dueDate: "nullableText",
    priority: "integer",
    notes: "text",
    noteId: "nullableText",
  },
};

function kindOf(collection: CollectionName, field: string): Kind | undefined {
  const kinds: Readonly<Record<string, Kind>> = KINDS[collection];
  return Object.hasOwn(kinds, field) ? kinds[field] : undefined;
}

function convert(kind: Kind, field: string, raw: string): unknown {
  switch (kind) {
    case "text":
      return raw;
    case "nullableText":
      return raw === "null" ? null : raw;
    case "boolean":
      if (raw === "true") return true;
      if (raw === "false") return false;
      throw new UsageError(`${field} must be true or false`);
    case "integer":
      if (!/^-?\d{1,15}$/.test(raw)) throw new UsageError(`${field} must be an integer`);
      return Number(raw);
    case "list":
      return raw === "" ? [] : raw.split(",").map((item) => item.trim());
  }
}

/**
 * Read `name=value` assignments into field values of the collection. Values are converted by
 * the field's kind only; the collection's schema checks them when the mutation is made.
 */
export function parseAssignments(collection: CollectionName, assignments: readonly string[]): Record<string, unknown> {
  if (assignments.length === 0) throw new UsageError("give at least one field=value");
  const fields: Record<string, unknown> = {};
  for (const assignment of assignments) {
    const eq = assignment.indexOf("=");
    if (eq <= 0) throw new UsageError(`expected field=value, got ${JSON.stringify(assignment)}`);
    const field = assignment.slice(0, eq);
    const kind = kindOf(collection, field);
    if (!kind) throw new UsageError(`${collection} has no field ${field}`);
    if (Object.hasOwn(fields, field)) throw new UsageError(`${field} is set twice`);
    fields[field] = convert(kind, field, assignment.slice(eq + 1));
  }
  return fields;
}
