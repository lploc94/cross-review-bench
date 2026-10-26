import type { PhysicalClock } from "./clock.js";
import { ClockDriftError, HlcCounterOverflowError, InvalidHlcError } from "./errors.js";

/**
 * Hybrid logical clock (Kulkarni et al., "Logical Physical Clocks and Consistent Snapshots in
 * Globally Distributed Databases", 2014). A timestamp pairs the largest physical time seen with
 * a logical counter that orders events within one millisecond, and the id of the node that
 * issued it, so two timestamps from different nodes are never equal.
 */
export interface HlcTimestamp {
  readonly wallMs: number;
  readonly counter: number;
  readonly node: string;
}

const WALL_DIGITS = 15;
const COUNTER_DIGITS = 5;
export const MAX_WALL_MS = 10 ** WALL_DIGITS - 1;
export const MAX_COUNTER = 65_535;
export const MAX_NODE_ID_LENGTH = 64;
/** How far ahead of the local physical clock a received timestamp may be. */
export const DEFAULT_MAX_DRIFT_MS = 60_000;

/** Lowercase letters, digits and inner dashes: the canonical string form stays unambiguous. */
const NODE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const HLC_PATTERN = new RegExp(`^(\\d{${WALL_DIGITS}}):(\\d{${COUNTER_DIGITS}}):(.+)$`);

export function isValidNodeId(node: string): boolean {
  return node.length <= MAX_NODE_ID_LENGTH && NODE_ID_PATTERN.test(node);
}

function checkTimestamp(ts: HlcTimestamp): void {
  if (!Number.isSafeInteger(ts.wallMs) || ts.wallMs < 0 || ts.wallMs > MAX_WALL_MS) {
    throw new InvalidHlcError(`wall time ${ts.wallMs} is out of range`);
  }
  if (!Number.isSafeInteger(ts.counter) || ts.counter < 0 || ts.counter > MAX_COUNTER) {
    throw new InvalidHlcError(`counter ${ts.counter} is out of range`);
  }
  if (!isValidNodeId(ts.node)) {
    throw new InvalidHlcError(`invalid node id ${JSON.stringify(ts.node)}`);
  }
}

/**
 * The canonical string form `<wall, 15 digits>:<counter, 5 digits>:<node>`. Wall time and counter
 * are zero-padded to a fixed width, so comparing two strings by code units gives the same order
 * as compareHlc.
 */
export function formatHlc(ts: HlcTimestamp): string {
  checkTimestamp(ts);
  const wall = String(ts.wallMs).padStart(WALL_DIGITS, "0");
  const counter = String(ts.counter).padStart(COUNTER_DIGITS, "0");
  return `${wall}:${counter}:${ts.node}`;
}

export function parseHlc(text: string): HlcTimestamp {
  const match = HLC_PATTERN.exec(text);
  if (!match?.[1] || !match[2] || !match[3]) {
    throw new InvalidHlcError(`invalid timestamp ${JSON.stringify(text)}`);
  }
  const ts = { wallMs: Number(match[1]), counter: Number(match[2]), node: match[3] };
  checkTimestamp(ts);
  return ts;
}

export function isHlcString(text: string): boolean {
  try {
    parseHlc(text);
    return true;
  } catch {
    return false;
  }
}

/** Total order: wall time, then counter, then node id. */
export function compareHlc(a: HlcTimestamp, b: HlcTimestamp): -1 | 0 | 1 {
  if (a.wallMs !== b.wallMs) return a.wallMs < b.wallMs ? -1 : 1;
  if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1;
  if (a.node !== b.node) return a.node < b.node ? -1 : 1;
  return 0;
}

/** compareHlc on canonical strings; both are validated. */
export function compareHlcStrings(a: string, b: string): -1 | 0 | 1 {
  return compareHlc(parseHlc(a), parseHlc(b));
}

export interface HlcOptions {
  readonly node: string;
  readonly clock: PhysicalClock;
  readonly maxDriftMs?: number;
}

/**
 * The clock of one node. `now()` stamps a local event (a write, a message about to be sent);
 * `receive()` merges a timestamp from another node so that every later local timestamp is
 * greater than everything this node has seen.
 */
export class Hlc {
  readonly node: string;
  readonly maxDriftMs: number;
  private readonly clock: PhysicalClock;
  private lastWall = 0;
  private lastCounter = 0;

  constructor(options: HlcOptions) {
    if (!isValidNodeId(options.node)) {
      throw new InvalidHlcError(`invalid node id ${JSON.stringify(options.node)}`);
    }
    const maxDriftMs = options.maxDriftMs ?? DEFAULT_MAX_DRIFT_MS;
    if (!Number.isSafeInteger(maxDriftMs) || maxDriftMs < 0) {
      throw new RangeError(`maxDriftMs must be a non-negative integer, got ${maxDriftMs}`);
    }
    this.node = options.node;
    this.clock = options.clock;
    this.maxDriftMs = maxDriftMs;
  }

  /** The last timestamp this clock issued or received (wall 0 before the first one). */
  get last(): HlcTimestamp {
    return { wallMs: this.lastWall, counter: this.lastCounter, node: this.node };
  }

  /**
   * Continue from a timestamp this node stored before it stopped. Only moves the clock forward:
   * the next `now()` is greater than both `stored` and the current physical time.
   */
  restore(stored: HlcTimestamp): void {
    checkTimestamp(stored);
    if (
      stored.wallMs > this.lastWall ||
      (stored.wallMs === this.lastWall && stored.counter > this.lastCounter)
    ) {
      this.lastWall = stored.wallMs;
      this.lastCounter = stored.counter;
    }
  }

  /** Timestamp a local or send event. */
  now(): HlcTimestamp {
    const physical = this.physical();
    if (physical > this.lastWall) {
      this.lastWall = physical;
      this.lastCounter = 0;
    } else {
      this.lastCounter = this.nextCounter(this.lastCounter + 1, this.lastWall);
    }
    return this.last;
  }

  /** Merge a timestamp received from another node, and timestamp the receive event. */
  receive(remote: HlcTimestamp): HlcTimestamp {
    checkTimestamp(remote);
    const physical = this.physical();
    if (remote.wallMs - physical > this.maxDriftMs) {
      throw new ClockDriftError(remote.wallMs, physical, this.maxDriftMs);
    }
    const wall = Math.max(this.lastWall, remote.wallMs, physical);
    let counter: number;
    if (wall === this.lastWall && wall === remote.wallMs) {
      counter = Math.max(this.lastCounter, remote.counter) + 1;
    } else if (wall === this.lastWall) {
      counter = this.lastCounter + 1;
    } else if (wall === remote.wallMs) {
      counter = remote.counter + 1;
    } else {
      counter = 0;
    }
    this.lastCounter = this.nextCounter(counter, wall);
    this.lastWall = wall;
    return this.last;
  }

  private nextCounter(counter: number, wall: number): number {
    if (counter > MAX_COUNTER) throw new HlcCounterOverflowError(wall);
    return counter;
  }

  private physical(): number {
    const ms = Math.floor(this.clock.now());
    if (!Number.isSafeInteger(ms) || ms < 0 || ms > MAX_WALL_MS) {
      throw new RangeError(`physical clock returned ${ms}`);
    }
    return ms;
  }
}
