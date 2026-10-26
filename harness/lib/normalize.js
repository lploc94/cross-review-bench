// Findings as the judges see them: locations normalized to workspace-relative `file:lines`, and
// everything that could tell one reviewer from another removed (Phase 7, blind grading).

import crypto from "node:crypto";
import { parseLocations, fileNames } from "./scenarios.js";

// a run dir or workspace as a path: /tmp/crw/<8-hex>[/<repo>][/] (macOS shows /tmp as /private/tmp);
// the end of a bare path is a character that cannot continue it
const END = "(?=$|[\\s)#`'\",;:\\]>])";
const RUN_WS = new RegExp(`(?:file://)?(?:/private)?/tmp/crw/[0-9a-f]{8}(?:/[^/\\s)#\`'",;:\\]>]+)?(?:/|${END})`, "g");

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Text with the run's workspace prefix (and any /tmp/crw/<hex>/<repo>/ prefix) removed, so paths are
 * repo-relative; the workspace itself, named without a trailing slash, becomes `.`.
 */
export function stripWorkspace(text, workspaceRoot) {
  let out = String(text ?? "");
  if (workspaceRoot) {
    const root = workspaceRoot.replace(/\/+$/, "");
    const roots = [root];
    if (root.startsWith("/private/")) roots.push(root.slice("/private".length));
    else if (root.startsWith("/")) roots.push(`/private${root}`);
    // the longer form first: /private/tmp/… contains /tmp/…
    for (const r of roots.sort((a, b) => b.length - a.length)) out = out.replace(new RegExp(`(?:file://)?${escapeRe(r)}(?:/|${END})`, "g"), m => (m.endsWith("/") ? "" : "."));
  }
  return out.replace(RUN_WS, m => (m.endsWith("/") ? "" : "."));
}

/**
 * The locations an issue's Location names: [{ file, start, end }], files repo-relative. A location
 * naming a file without lines gives { file, start: null, end: null }; one naming no file gives
 * [{ file: null, start: null, end: null }] (the finding is still judged).
 */
export function parseLocation(str, workspaceRoot) {
  const loc = stripWorkspace(str, workspaceRoot);
  const clean = f => f.replace(/^\.\//, "");
  const found = parseLocations({ location: loc }).map(l => ({ ...l, file: clean(l.file) }));
  if (found.length) return found;
  const files = [...new Set(fileNames(loc).map(clean))];
  if (files.length) return files.map(file => ({ file, start: null, end: null }));
  return [{ file: null, start: null, end: null }];
}

/** `a.ts:3-5, b.ts:9`, or "unknown". */
export function formatLocations(locs) {
  const parts = locs.filter(l => l.file).map(l => (l.start == null ? l.file : l.start === l.end ? `${l.file}:${l.start}` : `${l.file}:${l.start}-${l.end}`));
  return parts.length ? parts.join(", ") : "unknown";
}

const LINK = /\[([^\]]*)\]\(([^)\s]+)\)/g;

/**
 * Prose with markdown links to workspace files written as plain `label (path:lines)`, workspace
 * prefixes stripped and issue numbers removed; links to the web are kept.
 */
export function cleanText(text, workspaceRoot) {
  let out = String(text ?? "").replace(LINK, (whole, label, url) => {
    if (/^https?:/i.test(url)) return whole;
    const anchor = url.match(/#L(\d+)(?:-L?(\d+))?$/i);
    let target = stripWorkspace(url.replace(/^file:\/\//i, "").replace(/#.*$/, ""), workspaceRoot);
    try { target = decodeURIComponent(target); } catch {}
    if (anchor) target += `:${anchor[1]}${anchor[2] && anchor[2] !== anchor[1] ? `-${anchor[2]}` : ""}`;
    const plain = label.replace(/`/g, "").trim();
    return !plain || target.includes(plain) || plain.includes(target) ? `\`${target}\`` : `${label} (\`${target}\`)`;
  });
  out = stripWorkspace(out, workspaceRoot);
  // another finding's number tells which run it came from
  return out.replace(/\bISSUE-\d+\b/g, "another finding").trim();
}

/** The block's title without markdown emphasis or code marks. */
function plainTitle(title, workspaceRoot) {
  return cleanText(title, workspaceRoot).replace(/[`*_]+/g, "").replace(/\s+/g, " ").trim();
}

/**
 * One ISSUE block as the judges see it: category, severity, normalized location, title, problem,
 * evidence and suggested fix; no issue number, no "why it matters", no verdict.
 */
export function anonymize(block, { workspaceRoot } = {}) {
  const locations = parseLocation(block?.location, workspaceRoot);
  return {
    category: String(block?.category ?? "").trim().toLowerCase() || null,
    severity: String(block?.severity ?? "").trim().toLowerCase() || null,
    location: formatLocations(locations),
    locations,
    title: plainTitle(block?.title ?? "", workspaceRoot),
    problem: cleanText(block?.problem, workspaceRoot),
    evidence: cleanText(block?.evidence, workspaceRoot),
    suggested_fix: cleanText(block?.suggested_fix, workspaceRoot),
  };
}

/** A deterministic PRNG in [0, 1) from a string seed (FNV-1a hash, then mulberry32). */
export function seededRandom(seed) {
  let h = 0x811c9dc5;
  for (const c of String(seed)) { h ^= c.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  let a = h;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A copy of items in a seeded random order (Fisher–Yates). */
export function seededShuffle(items, seed) {
  const out = [...items];
  const rand = seededRandom(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** A stable number in [0, 1) for a key (seeded sampling). */
export function keyFraction(seed, key) {
  return crypto.createHash("sha256").update(`${seed}\0${key}`).digest().readUInt32BE(0) / 2 ** 32;
}
