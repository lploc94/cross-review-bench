import { compareHlc, parseHlc } from "./hlc.js";
import { MutationValidationError } from "./errors.js";

/**
 * Per-field last-writer-wins. Every field of a document carries the timestamp of the write that
 * set it; a later write replaces the value only when its timestamp is greater. Timestamps include
 * the writer's node id, so two different writes never tie, and every replica that has seen the
 * same writes holds the same document whatever order they arrived in.
 */

/** Field names: an identifier, never an Object.prototype key such as `__proto__`. */
export const FIELD_NAME_PATTERN = /^[a-z][A-Za-z0-9]{0,63}$/;

export interface FieldWrite {
  readonly field: string;
  readonly value: unknown;
  /** Canonical HLC string of the mutation that wrote the field. */
  readonly hlc: string;
}

export interface DocState {
  readonly fields: Readonly<Record<string, unknown>>;
  /** For each field in `fields`, the canonical HLC of the write that set it. */
  readonly fieldHlcs: Readonly<Record<string, string>>;
}

export const EMPTY_DOC_STATE: DocState = Object.freeze({
  fields: Object.freeze({}),
  fieldHlcs: Object.freeze({}),
});

export interface MergeResult {
  readonly state: DocState;
  /** The writes that replaced a value (or set a new field), in input order. */
  readonly applied: FieldWrite[];
  /** The writes that lost to the stored value. */
  readonly skipped: FieldWrite[];
}

/** Whether a write stamped `incoming` replaces a field last written at `current`. */
export function writeWins(current: string | undefined, incoming: string): boolean {
  const next = parseHlc(incoming);
  if (current === undefined) return true;
  return compareHlc(next, parseHlc(current)) > 0;
}

function storedHlc(state: DocState, field: string): string | undefined {
  return Object.hasOwn(state.fieldHlcs, field) ? state.fieldHlcs[field] : undefined;
}

/**
 * Apply `writes` in order to `state` and return the new state; `state` is not modified. Writes
 * to the same field are resolved by their timestamps, not by their position.
 */
export function mergeWrites(state: DocState, writes: readonly FieldWrite[]): MergeResult {
  const fields: Record<string, unknown> = { ...state.fields };
  const fieldHlcs: Record<string, string> = { ...state.fieldHlcs };
  const applied: FieldWrite[] = [];
  const skipped: FieldWrite[] = [];
  for (const write of writes) {
    if (!FIELD_NAME_PATTERN.test(write.field)) {
      throw new MutationValidationError(`invalid field name ${JSON.stringify(write.field)}`, [
        { field: write.field, message: "invalid field name" },
      ]);
    }
    const current = Object.hasOwn(fieldHlcs, write.field) ? fieldHlcs[write.field] : undefined;
    if (writeWins(current, write.hlc)) {
      fields[write.field] = write.value;
      fieldHlcs[write.field] = write.hlc;
      applied.push(write);
    } else {
      skipped.push(write);
    }
  }
  return { state: { fields, fieldHlcs }, applied, skipped };
}

/** The HLC of the last write to a field, if the field was ever written. */
export function fieldHlc(state: DocState, field: string): string | undefined {
  return storedHlc(state, field);
}

/** The greatest field timestamp of a document, or undefined for an empty one. */
export function latestHlc(state: DocState): string | undefined {
  let latest: string | undefined;
  for (const hlc of Object.values(state.fieldHlcs)) {
    if (latest === undefined || compareHlc(parseHlc(hlc), parseHlc(latest)) > 0) latest = hlc;
  }
  return latest;
}
