// crb export (Phase 22): the release bundle. It carries the corpus's base repositories, the public
// tasks with their answer keys and every real bug (splits.json), the final set's run archives, score
// rows and pooled bugs of public tasks, and the bench's harness, analysis and write-ups; a manifest gives the SHA-256 of
// every file. Private tasks stay out entirely, so the bench can be re-run on them later without their
// answers having been seen (METHODOLOGY "Split"). Every text file is checked before the bundle is
// published: the home path is redacted to "~"; a private task id (outside splits.json and the Track C task list), a
// private bug's summary, a byte copy of a private task file, a denied string or a login token fails
// the export, which then leaves nothing behind.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const BENCH_FILES = new Set(["METHODOLOGY.md", "README.md", "package.json", "package-lock.json", "LICENSE"]);
const BENCH_DIRS = ["harness/", "analysis/", "report/", "results/", "calibration/", "trackc/", "pilot/"];
const CORPUS_FILES = new Set(["README.md", "CORPUS-GUIDE.md", "splits.json"]);
// files that may name private tasks: the split and the pre-registered Track C task list name ids, nothing more
const MAY_NAME_PRIVATE = new Set(["corpus/splits.json", "bench/trackc/tasks.txt"]);
const TOKENS = [
  /"(?:access_token|refresh_token|id_token|api_key|apiKey)"\s*:\s*"[^"]{16,}"/,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bya29\.[A-Za-z0-9_-]{20,}/,
];
const MIN_SUMMARY = 20; // shorter summaries are too generic to mark a leak
const MIN_COPY = 64; // a private file this small (a blank line, "{}") is not answer material

const sha = buf => crypto.createHash("sha256").update(buf).digest("hex");
const isText = buf => !buf.subarray(0, 8000).includes(0);
const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const gitFiles = dir => execFileSync("git", ["-C", dir, "ls-files", "-z"], { encoding: "utf8", maxBuffer: 1 << 28 }).split("\0").filter(Boolean);
const gitHead = dir => execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

const walkFiles = dir => fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter(e => e.isFile()).map(e => path.relative(dir, path.join(e.parentPath, e.name)));

/** Run archives of a set under the runs dir: [{ rel, task }] (rel: the archive's path below runs/). */
function runArchives(runs, set) {
  const out = [];
  const walk = dir => {
    if (fs.existsSync(path.join(dir, "run.json"))) {
      out.push({ rel: path.relative(runs, dir), task: JSON.parse(fs.readFileSync(path.join(dir, "run.json"), "utf8")).task });
      return;
    }
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) walk(path.join(dir, e.name));
  };
  if (fs.existsSync(path.join(runs, set))) walk(path.join(runs, set));
  return out;
}

/**
 * Writes the bundle to `out` (which must not exist). `corpus` and `bench` are git checkouts (their
 * tracked files are read from the working tree), `runs` the archive root, `home` the path to redact,
 * `deny` strings that must not appear. Returns { out, files, bytes, public_tasks, private_tasks_omitted }.
 */
export function exportBundle({ out, corpus, bench, runs, set = "final", home, deny = [] }) {
  if (fs.existsSync(out)) throw new Error(`${out} exists; export writes a new folder`);
  const splitsFile = path.join(corpus, "splits.json");
  if (!fs.existsSync(splitsFile)) throw new Error(`the corpus has no splits.json: run crb split --write first`);
  const splits = JSON.parse(fs.readFileSync(splitsFile, "utf8"));
  const pub = new Set(splits.public);
  const priv = new Set(splits.private);
  const known = id => {
    if (!pub.has(id) && !priv.has(id)) throw new Error(`task ${id} is in neither split of splits.json`);
    return pub.has(id);
  };

  // what to copy: [bundle path, source file]
  const items = [];
  const corpusFiles = gitFiles(corpus);
  const privateFiles = [];
  for (const rel of corpusFiles) {
    const parts = rel.split("/");
    if (parts[0] === "tasks" && parts.length > 3) {
      if (known(parts[2])) items.push([`corpus/${rel}`, path.join(corpus, rel)]);
      else privateFiles.push(path.join(corpus, rel));
    } else if (parts[0] === "realbugs" && parts.length > 2) {
      if (!known(parts[1])) throw new Error(`real bug ${parts[1]} is private; every real bug is public`);
      items.push([`corpus/${rel}`, path.join(corpus, rel)]);
    } else if (parts[0] === "repos" || CORPUS_FILES.has(rel)) items.push([`corpus/${rel}`, path.join(corpus, rel)]);
  }
  for (const rel of gitFiles(bench)) {
    if (BENCH_FILES.has(rel) || BENCH_DIRS.some(d => rel.startsWith(d))) items.push([`bench/${rel}`, path.join(bench, rel)]);
  }
  for (const a of runArchives(runs, set)) {
    if (!known(a.task)) continue;
    for (const f of walkFiles(path.join(runs, a.rel))) items.push([`runs/${a.rel}/${f}`, path.join(runs, a.rel, f)]);
  }

  // what must not appear
  const privateHashes = new Set(privateFiles.map(f => fs.readFileSync(f)).filter(b => b.length >= MIN_COPY).map(sha));
  // the answer key's prose: each bug's summary, trigger and false rebuttal, each decoy's explanation
  const summaries = [];
  for (const id of priv) {
    const tj = privateFiles.find(f => f.endsWith(`/${id}/task.json`));
    if (!tj) continue;
    const t = JSON.parse(fs.readFileSync(tj, "utf8"));
    const prose = [
      ...(t.bugs ?? []).flatMap(b => [b.summary, b.trigger, b.false_rebuttal]),
      ...(t.decoys ?? []).flatMap(d => [d.looks_like, d.why_correct, d.valid_rebuttal]),
    ];
    // also as a transcript stores it: JSON-escaped once, or inside another JSON string (a command's output)
    for (const s of prose) {
      if (typeof s !== "string" || s.length < MIN_SUMMARY) continue;
      const once = JSON.stringify(s).slice(1, -1);
      summaries.push(...new Set([s, once, JSON.stringify(once).slice(1, -1)]));
    }
  }
  const privateIds = priv.size ? new RegExp(`(?<![\\w-])(?:${[...priv].map(escape).join("|")})(?![\\w])`) : null;
  const denied = [...deny, ...(home ? [home] : [])].filter(Boolean);
  const redact = home ? new RegExp(escape(home.replace(/\/+$/, "")), "g") : null;

  const tmp = `${out}.partial-${crypto.randomBytes(4).toString("hex")}`;
  const files = [];
  let bytes = 0;
  try {
    for (const [dest, src] of items) {
      // a tracked link is copied as a link (its target may live in an upstream submodule the corpus lacks);
      // its target path goes through the same checks as a file's text
      const link = fs.lstatSync(src).isSymbolicLink();
      let buf = link ? Buffer.from(fs.readlinkSync(src), "utf8") : fs.readFileSync(src);
      if (privateHashes.has(sha(buf))) throw new Error(`${dest} is a copy of a private task file`);
      if (isText(buf)) {
        let text = buf.toString("utf8");
        if (redact) text = text.replace(redact, "~");
        if (dest.startsWith("bench/results/") && dest.endsWith(".jsonl")) {
          text = text.split("\n").filter(l => {
            if (!l.trim()) return false;
            const t = JSON.parse(l).task;
            return t === undefined || known(t);
          }).map(l => `${l}\n`).join("");
        }
        if (dest === "bench/results/pool.json") {
          const pool = JSON.parse(text);
          text = JSON.stringify({ ...pool, bugs: pool.bugs.filter(b => known(b.task)) }, null, 2) + "\n";
        }
        const id = privateIds && !MAY_NAME_PRIVATE.has(dest) ? text.match(privateIds) : null;
        if (id) throw new Error(`${dest} names private task ${id[0]}`);
        const summary = summaries.find(s => text.includes(s));
        if (summary) throw new Error(`${dest} contains prose from a private task's answer key`);
        const d = denied.find(s => text.includes(s));
        if (d) throw new Error(`${dest} contains the denied string ${JSON.stringify(d)}`);
        if (!dest.startsWith("corpus/")) {
          const tok = TOKENS.find(re => re.test(text));
          if (tok) throw new Error(`${dest} looks like it holds a login token (${tok.source.slice(0, 40)}…)`);
        }
        buf = Buffer.from(text, "utf8");
      }
      const file = path.join(tmp, dest);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (link) fs.symlinkSync(buf.toString("utf8"), file);
      else {
        fs.writeFileSync(file, buf);
        // an executable (a CLI entry point, a repo's test script) stays one
        if (fs.statSync(src).mode & 0o111) fs.chmodSync(file, 0o755);
      }
      files.push({ path: dest, sha256: sha(buf), bytes: buf.length, ...(link ? { symlink: true } : {}) });
      bytes += buf.length;
    }
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const manifest = {
      format: "crb-release/v1",
      created_at: new Date().toISOString(),
      set,
      corpus_commit: gitHead(corpus),
      bench_commit: gitHead(bench),
      split_seed: splits.seed ?? null,
      public_tasks: pub.size,
      private_tasks_omitted: priv.size,
      files,
    };
    fs.writeFileSync(path.join(tmp, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    fs.renameSync(tmp, out);
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  return { out, files: files.length, bytes, public_tasks: pub.size, private_tasks_omitted: priv.size };
}
