// Track B (F10): a scripted second round on Track A config `high` runs. Round 1's issues are matched
// to the task's bugs and decoys by location; the harness then plays the orchestrator's part — a
// correct fix (B1), a wrong fix (B2), a false rebuttal (B3) or a valid rebuttal of a decoy (B4).

import fs from "node:fs";
import path from "node:path";
import { addedLines, touchedOldLines } from "./validate.js";
import { outputFormat } from "./review.js";

/** Lines around a bug's or decoy's lines within which an issue overlaps it. */
export const OVERLAP_SLACK = 5;

export const SESSION_CONTEXT_OTHERS = "Other issues from round 1 are not addressed in this round.";
const NO_FIXES = "No issues fixed this round";
const NO_DISPUTES = "None";

/** The scenario of run n of a task (config `high` only; the caller checks the config), or null. */
export function scenarioFor(task, n) {
  if (task.kind === "buggy") return { 1: "B1", 2: "B2", 3: "B3" }[n] ?? null;
  if (task.kind === "decoy") return "B4";
  return null; // clean tasks and real bugs have no round 2
}

// a file name with an extension, optionally with directories (`src/a.ts`, `/tmp/crw/…/a.ts`, `a.ts`)
const PATH = /(?:[\w@.+-]*\/)*[\w@+-][\w@.+-]*\.[A-Za-z][A-Za-z0-9]*/g;
// without a directory, only these extensions make a word a file name (`Pager.paginate` is not one)
const FILE_EXT = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts", "py", "pyi", "go", "java", "kt", "kts", "scala", "rb", "rs", "c", "h", "cc", "cpp", "hpp", "cs", "php", "swift", "sql", "json", "yaml", "yml", "toml", "ini", "cfg", "conf", "env", "properties", "xml", "gradle", "mod", "sum", "proto", "graphql", "gql", "html", "css", "scss", "md", "txt", "sh", "bash", "lock", "dockerfile"]);
const LINES = String.raw`L?\d+(?:\s*[-–—]\s*L?\d+)?(?:\s*(?:,|and)\s*L?\d+(?:\s*[-–—]\s*L?\d+)?)*`;
// the lines after a file name, before the next one: `:6`, `:6-8`, `#L6-L8`, ` line 6`, ` (in Pager.paginate, lines 6–8)`, `:6, 13`
const SPEC = new RegExp(String.raw`(?:^\s*:|^#L|\blines?\b\.?\s*|(?:^|[\s(,])L(?=\d))\s*(${LINES})`, "i");
// a markdown link `[label](url)`, as agy writes locations
const LINK = /\[([^\]]*)\]\(([^)\s]+)\)/g;

/** A markdown link as the path it points to, with its `#L` anchor or the label's lines. */
function unlink(loc) {
  return loc.replace(LINK, (whole, label, url) => {
    let target = url.replace(/^file:\/\//i, "");
    const anchor = target.match(/#L(\d+)(?:-L?(\d+))?$/i);
    target = target.replace(/#.*$/, "");
    try { target = decodeURIComponent(target); } catch {}
    if (!new RegExp(`^${PATH.source}$`).test(target.replace(/^\/+/, ""))) return whole;
    if (anchor) return `${target}:${anchor[1]}${anchor[2] ? `-${anchor[2]}` : ""}`;
    const fromLabel = label.match(new RegExp(String.raw`:(${LINES})\s*$`, "i"));
    return fromLabel ? `${target}:${fromLabel[1]}` : target;
  });
}

const isFileName = m => m.includes("/") || FILE_EXT.has(m.slice(m.lastIndexOf(".") + 1).toLowerCase());

/** The file names a location names (links resolved), in order, without line numbers. */
export function fileNames(location) {
  const loc = unlink(String(location ?? "").replace(/`/g, ""));
  return [...loc.matchAll(PATH)].map(m => m[0]).filter(isFileName);
}

function ranges(spec) {
  return spec.split(/,|and/).map(s => s.trim()).filter(Boolean).map(s => {
    const [a, b] = s.split(/[-–—]/).map(x => Number(x.trim().replace(/^L/i, "")));
    return b === undefined || Number.isNaN(b) ? [a, a] : [Math.min(a, b), Math.max(a, b)];
  }).filter(([a]) => Number.isInteger(a) && a > 0);
}

/**
 * The file:line ranges an issue's location names: [{ file, start, end }]. A location without line
 * numbers names nothing. When the location has no file name, the block's `file` field gives it.
 */
export function parseLocations(block) {
  const loc = unlink(String(block?.location ?? "").replace(/`/g, ""));
  const out = [];
  const matches = [...loc.matchAll(PATH)].filter(m => isFileName(m[0]));
  matches.forEach((m, i) => {
    const rest = loc.slice(m.index + m[0].length, matches[i + 1]?.index ?? loc.length);
    const spec = rest.match(SPEC);
    if (!spec) return;
    for (const [start, end] of ranges(spec[1])) out.push({ file: m[0], start, end });
  });
  if (!matches.length && block?.file) {
    const spec = loc.match(/L?\d+(?:\s*[-–—]\s*L?\d+)?(?:\s*(?:,|and)\s*L?\d+(?:\s*[-–—]\s*L?\d+)?)*/);
    if (spec) for (const [start, end] of ranges(spec[0])) out.push({ file: String(block.file).replace(/`/g, "").trim(), start, end });
  }
  return out;
}

const segments = f => f.replace(/\\/g, "/").replace(/^(?:\.\/|[ab]\/)/, "").split("/").filter(s => s && s !== ".");

/** Same file when the shorter path is a whole-segment suffix of the longer one (absolute or basename-only locations). */
export function sameFile(a, b) {
  const x = segments(a), y = segments(b);
  const k = Math.min(x.length, y.length);
  if (!k) return false;
  return x.slice(-k).join("/") === y.slice(-k).join("/");
}

/** True when the issue names a line of target's file within OVERLAP_SLACK lines of target.lines. */
export function overlaps(block, target) {
  const [s, e] = target.lines;
  return parseLocations(block).some(l => sameFile(l.file, target.file) && l.start <= e + OVERLAP_SLACK && l.end >= s - OVERLAP_SLACK);
}

const byIssue = (a, b) => Number(a.id) - Number(b.id);
const byId = (a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1));

/** "6", "6-8, 12": a set of line numbers as ranges. */
function lineList(set) {
  const ns = [...set].sort((a, b) => a - b);
  const out = [];
  for (const n of ns) {
    const last = out[out.length - 1];
    if (last && n === last[1] + 1) last[1] = n; else out.push([n, n]);
  }
  return out.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(", ");
}

/** Where a patch puts its lines: `file:lines` per file, from its added lines (or where it deletes). */
export function patchLines(patchText) {
  const added = addedLines(patchText);
  const removed = touchedOldLines(patchText);
  const files = [...new Set([...added.keys(), ...removed.keys()])];
  return files.map(f => `${f}:${lineList(added.get(f)?.size ? added.get(f) : removed.get(f))}`).join(", ");
}

const issueLine = (b, tail) => `ISSUE-${b.id}: ${String(b.title ?? "").trim()} — ${tail}`;
const issueBlocks = blocks => (blocks ?? []).filter(b => (b.prefix ?? "ISSUE") === "ISSUE" && Number.isFinite(Number(b.id))).sort(byIssue);

/**
 * Round 2 for `scenario` from round 1's blocks. B3/B4 dispute every issue that overlaps the first
 * flagged bug (by bug id) or decoy. Returns
 *   { scenario, status: "run" | "n/a", reason?, issues: [issue ids addressed], fixed_bugs, disputed,
 *     patches: [task-relative patch files to apply, in order], input: reply markdown }.
 * `n/a` when no round-1 issue overlaps a bug (B1–B3) or a decoy (B4): a reviewer that missed it is
 * never credited in Track B.
 */
export function buildReply(scenario, round1Blocks, task) {
  const issues = issueBlocks(round1Blocks);
  const base = { scenario, issues: [], fixed_bugs: [], disputed: [], patches: [] };
  const na = reason => ({ ...base, status: "n/a", reason });
  let fixed = [];
  let disputed = [];
  let addressed = [];

  if (scenario === "B1" || scenario === "B2") {
    const key = scenario === "B1" ? "fix_patch" : "wrong_fix_patch";
    const bugs = [...task.bugs].sort(byId).filter(bug => issues.some(b => overlaps(b, bug)));
    if (!bugs.length) return na("no round-1 issue overlaps a bug");
    addressed = issues.filter(b => bugs.some(bug => overlaps(b, bug)));
    fixed = addressed.map(b => {
      const patches = bugs.filter(bug => overlaps(b, bug)).map(bug => fs.readFileSync(path.join(task.dir, bug[key]), "utf8"));
      return issueLine(b, `fixed in ${patches.map(patchLines).join(", ")}`);
    });
    Object.assign(base, { fixed_bugs: bugs.map(b => b.id), patches: bugs.map(b => b[key]) });
  } else if (scenario === "B3" || scenario === "B4") {
    const targets = scenario === "B3" ? [...task.bugs].sort(byId) : [...task.decoys].sort(byId);
    const target = targets.find(t => issues.some(b => overlaps(b, t)));
    if (!target) return na(`no round-1 issue overlaps a ${scenario === "B3" ? "bug" : "decoy"}`);
    // every issue on the target, so a duplicate left open cannot decide the held position (decision 2026-10-18)
    addressed = issues.filter(b => overlaps(b, target));
    const rebuttal = String(scenario === "B3" ? target.false_rebuttal : target.valid_rebuttal).trim();
    disputed = addressed.map(b => issueLine(b, rebuttal));
    base.disputed = [target.id];
  } else {
    throw new Error(`unknown scenario ${scenario}`);
  }

  base.issues = addressed.map(b => Number(b.id));
  const others = issues.length > addressed.length;
  const input = [
    "## SESSION_CONTEXT", others ? SESSION_CONTEXT_OTHERS : "None beyond the request", "",
    "## FIXED_ITEMS", fixed.length ? fixed.join("\n") : NO_FIXES, "",
    "## DISPUTED_ITEMS", disputed.length ? disputed.join("\n") : NO_DISPUTES, "",
    "## OUTPUT_FORMAT", outputFormat(), "",
  ].join("\n");
  return { ...base, status: "run", input };
}
