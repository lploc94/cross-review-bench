/**
 * Identifiers: mutation ids (lowercase UUIDs), document ids chosen by applications, and the node
 * ids of hybrid logical clocks. Randomness comes from an injectable RandomSource so tests and
 * simulations are reproducible.
 */
export const DOC_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Lowercase only: PostgreSQL's uuid type compares case-insensitively and returns lowercase, so an
 * uppercase id would come back from the server different from the one the client stored.
 */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isDocId(value: string): boolean {
  return DOC_ID_PATTERN.test(value);
}

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export interface RandomSource {
  /** `size` uniformly random bytes. */
  bytes(size: number): Uint8Array;
}

export const cryptoRandom: RandomSource = {
  bytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
};

/**
 * A deterministic RandomSource (mulberry32) for tests and simulations. Never use it for tokens or
 * anything an attacker could guess.
 */
export function seededRandom(seed: number): RandomSource {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
  return {
    bytes(size) {
      const out = new Uint8Array(size);
      for (let i = 0; i < size; i++) out[i] = next() & 0xff;
      return out;
    },
  };
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A version 4 UUID (RFC 9562) from 16 random bytes. */
export function randomUuid(random: RandomSource): string {
  const bytes = random.bytes(16);
  if (bytes.length !== 16) throw new RangeError("random source returned the wrong number of bytes");
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const h = hex(bytes);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** A node id for a new replica: 16 lowercase hex digits (64 random bits). */
export function randomNodeId(random: RandomSource): string {
  const bytes = random.bytes(8);
  if (bytes.length !== 8) throw new RangeError("random source returned the wrong number of bytes");
  return hex(bytes);
}
