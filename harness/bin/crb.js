#!/usr/bin/env node
// crb: the Cross-Review Bench harness CLI.

import { parseArgs } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { validateTask } from "../lib/validate.js";
import { listTasks, loadTask, quotaStats } from "../lib/task.js";
import { BENCH_ROOT, corpusRoot, crbHome, realHome } from "../lib/paths.js";
import { REVIEWERS, SETS, DEFAULT_CONCURRENCY, RETRY, QUOTAS } from "../lib/config.js";
import { planRuns, runBatch, selectTaskDirs, checkFreeDisk, decide } from "../lib/scheduler.js";
import { addPlanned, plannedIds, listRuns, writeAtomic } from "../lib/store.js";
import { reauditSet, restoreUnflagged } from "../lib/reaudit.js";
import { up, down, status as servicesStatus, taskServices } from "../lib/services.js";
import { warm } from "../lib/cache.js";
import { checkRepo } from "../lib/repocheck.js";
import { planLoops, runTrackC, ORCHESTRATORS, CELLS } from "../lib/trackc.js";
import { judgeSet } from "../lib/grade/judge.js";
import { poolSet } from "../lib/grade/pool.js";
import { syncAuditQueue, queueStatus, nextItem, showItem, recordVerdict } from "../lib/grade/auditq.js";
import { scoreSet } from "../lib/grade/score.js";
import { mine, findIntro, selectionOrder, SINCE } from "../lib/realbugs.js";
import { makeSplits, checkSplit, pickTrackC, SPLIT_SEED } from "../lib/split.js";
import { checkReport } from "../lib/checkreport.js";
import { exportBundle } from "../lib/export.js";

const USAGE = `usage: crb <command> [options]

commands:
  validate <task-dir> | --repo <repo> | --all | --realbugs [--json]
  validate --repo <repo> | --all --stats    (F8 quota table from task.json; no oracles run)
  run --set S --track A --config high|max --tasks <glob|file> [--reviewers codex,claude,agy] [--n 3]
      [--model <reviewer>=<model>]... [--concurrency codex=3,claude=3,agy=2] [--dry-run]
      (run and trackc start no new run while ~/.crbench/pause exists or a process matching
       CRB_YIELD_TO (pgrep -f) runs; runs in flight finish)
  trackc --set S --tasks <glob|file> [--orchestrators claude,codex] [--cells codex,claude,agy,none]
      [--concurrency claude=3,codex=3] [--dry-run]
  status --set S [--track A|B|C] [--complete]
  audit --set S --all [--requeue] [--restore]      (current rules; --requeue: a newly flagged run is run again,
                                                   or contaminated at its second flag; --restore: after a rule
                                                   was narrowed, a run's first clean attempt becomes its result)
  services up|down|status
  cache warm <repo> | --all | --realbugs [<id>...]
  repo-check <repo> | --all [--json]
  judge --set S [--tasks <task-id,...>]            (blind panel; writes panel.json, queues audits)
  pool --set S [--concurrency N]                   (re-check confirmed pooled bugs, N at once (default 1);
                                                   queue new candidates)
  audit-queue next|status --set S | show <item> --set S
  audit-queue record <item> --set S --verdict real|not_real [--match B1,P2|none]
      (--repro-cmd "<cmd>" --result pass|fail|n/a | --evidence <file>) [--file F --lines A-B --severity S --summary "..."]
  score --set S
  split [--write]    (public/private split per repository; --write saves the corpus's splits.json)
  trackc-tasks [--write]    (the 40 Track C tasks; --write saves trackc/tasks.txt for crb trackc --tasks)
  export --out DIR [--set final]
      (release bundle: public tasks with answer keys, real bugs, public runs and scores, harness,
       analysis, write-ups, manifest.json with SHA-256; fails on any private answer material or leak)
  check-report [--report F] [--article F] [--leaderboard F]
      (numbers in the marked leaderboard tables equal leaderboard.json; exit 1 on a mismatch)
  realbugs mine [--since 2026-07-01] [--langs ts,py,go,java] [--min-stars 1000] [--pages 3] [--all]
      [--by-repo [--max-size-kb 200000]] [--per-repo N]
      (candidate fix PRs as JSON; --all keeps the rejected ones with their reasons; --by-repo lists
       the language's repositories first and searches each one's PRs; --per-repo N stops examining
       a repository's PRs, in the seeded order, once N pass; progress on stderr)
  realbugs order <mine.json>    (passing candidates per language in the fixed examination order)
  realbugs intro --repo-dir <clone> --fix <sha> --repo <owner/name> --lang ts|py|go|java
      (blame the fixed lines in the fix's parent; the introducing PR as JSON)
`;

function requireSet(values) {
  if (!SETS.includes(values.set)) throw new Error(`--set is required: one of ${SETS.join(", ")}`);
  return values.set;
}

function parsePairs(list, what) {
  const out = {};
  for (const item of list.flatMap(v => v.split(",")).filter(Boolean)) {
    const m = item.match(/^([a-z]+)=(.+)$/);
    if (!m || !REVIEWERS.includes(m[1])) throw new Error(`${what} must look like <reviewer>=<value> with reviewer one of ${REVIEWERS.join(", ")} (got ${item})`);
    out[m[1]] = m[2];
  }
  return out;
}

async function cmdRun(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      set: { type: "string" }, track: { type: "string", default: "A" }, config: { type: "string" },
      reviewers: { type: "string", default: REVIEWERS.join(",") }, tasks: { type: "string" }, n: { type: "string", default: "3" },
      model: { type: "string", multiple: true, default: [] }, concurrency: { type: "string", multiple: true, default: [] },
      "dry-run": { type: "boolean" },
    },
  });
  const set = requireSet(values);
  if (values.track !== "A") throw new Error("crb run handles --track A; Track B rides on Track A config high (F10) and Track C has `crb trackc`");
  if (!values.config) throw new Error("--config is required (high or max)");
  if (!values.tasks) throw new Error("--tasks is required");
  const reviewers = values.reviewers.split(",").filter(Boolean);
  for (const r of reviewers) if (!REVIEWERS.includes(r)) throw new Error(`unknown reviewer ${r}`);
  const n = Number(values.n);
  if (!Number.isInteger(n) || n < 1) throw new Error("--n must be a positive integer");
  const models = parsePairs(values.model, "--model");
  const concurrency = parseConcurrency(values.concurrency);

  const corpus = corpusRoot();
  const dirs = selectTaskDirs(values.tasks, corpus);
  if (!dirs.length) throw new Error(`--tasks ${values.tasks} matches no task in ${corpus}`);
  const tasks = dirs.map(d => loadTask(d, { corpus }));
  const runs = planRuns({ set, track: "A", config: values.config, reviewers, tasks, n, models });
  if (values["dry-run"]) {
    process.stdout.write(JSON.stringify({ set, planned: runs.length, runs: runs.map(r => r.id) }, null, 2) + "\n");
    return 0;
  }
  // the harness's own tests may lower the free-disk floor; real batches always use the Capacity value
  const minFreeBytes = process.env.CRB_TEST === "1" && process.env.CRB_MIN_FREE_BYTES ? Number(process.env.CRB_MIN_FREE_BYTES) : undefined;
  checkFreeDisk(minFreeBytes);
  addPlanned(set, runs.map(r => r.id));
  const summary = await runBatch(runs, {
    concurrency,
    minFreeBytes,
    onEvent: logEvent,
  });
  process.stdout.write(JSON.stringify({ set, ...summary }, null, 2) + "\n");
  return summary.infra_exhausted || summary.contaminated ? 1 : 0;
}

function parseConcurrency(list) {
  return Object.fromEntries(Object.entries({ ...DEFAULT_CONCURRENCY, ...parsePairs(list, "--concurrency") }).map(([k, v]) => {
    const c = Number(v);
    if (!Number.isInteger(c) || c < 1) throw new Error(`--concurrency ${k}=${v}: must be a positive integer`);
    return [k, c];
  }));
}

function logEvent(e) {
  if (e.type === "end") process.stderr.write(`${new Date().toISOString()} ${e.id} ${e.result.class}/${e.result.reason}${e.result.flagged ? " FLAGGED" : ""} -> ${e.decision}\n`);
  if (e.type === "pause") process.stderr.write(`${new Date().toISOString()} ${e.reviewer} paused until ${new Date(e.until).toISOString()} (usage limit)\n`);
  if (e.type === "hold") process.stderr.write(`${new Date().toISOString()} hold: no new run starts while ${e.reason}\n`);
  if (e.type === "resume") process.stderr.write(`${new Date().toISOString()} hold ended: new runs start again\n`);
}

/** Track C (F11): orchestrator × reviewer cell loops on buggy tasks, queued per orchestrator. */
async function cmdTrackc(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      set: { type: "string" }, tasks: { type: "string" },
      orchestrators: { type: "string", default: Object.keys(ORCHESTRATORS).join(",") }, cells: { type: "string", default: CELLS.join(",") },
      concurrency: { type: "string", multiple: true, default: [] }, "dry-run": { type: "boolean" },
    },
  });
  const set = requireSet(values);
  if (!values.tasks) throw new Error("--tasks is required");
  const concurrency = parseConcurrency(values.concurrency);
  const corpus = corpusRoot();
  const dirs = selectTaskDirs(values.tasks, corpus);
  if (!dirs.length) throw new Error(`--tasks ${values.tasks} matches no task in ${corpus}`);
  const tasks = dirs.map(d => loadTask(d, { corpus }));
  const loops = planLoops({ set, tasks, orchestrators: values.orchestrators.split(",").filter(Boolean), cells: values.cells.split(",").filter(Boolean) });
  if (values["dry-run"]) {
    process.stdout.write(JSON.stringify({ set, planned: loops.length, runs: loops.map(r => r.id) }, null, 2) + "\n");
    return 0;
  }
  const minFreeBytes = process.env.CRB_TEST === "1" && process.env.CRB_MIN_FREE_BYTES ? Number(process.env.CRB_MIN_FREE_BYTES) : undefined;
  checkFreeDisk(minFreeBytes);
  addPlanned(set, loops.map(r => r.id));
  const summary = await runBatch(loops, {
    concurrency, minFreeBytes, onEvent: logEvent,
    execute: (spec, counters) => runTrackC(spec, counters, { decisionFor: r => decide(r, counters, RETRY) }),
  });
  process.stdout.write(JSON.stringify({ set, ...summary }, null, 2) + "\n");
  return summary.infra_exhausted || summary.contaminated ? 1 : 0;
}

async function cmdStatus(argv) {
  const { values } = parseArgs({ args: argv, options: { set: { type: "string" }, track: { type: "string" }, complete: { type: "boolean" } } });
  const set = requireSet(values);
  const runs = listRuns(set).filter(r => !values.track || r.track === values.track);
  const counts = {};
  for (const r of runs) {
    const key = `${r.track}/${r.config}/${r.reviewer}`;
    counts[key] ??= {};
    counts[key][r.class] = (counts[key][r.class] ?? 0) + 1;
  }
  const planned = plannedIds(set).filter(id => !values.track || id.split("/")[1] === values.track);
  const byId = new Map(runs.map(r => [r.id, r]));
  const missing = planned.filter(id => !byId.has(id));
  // an exhausted run's class is its last fault (infra); the decision says it was given up
  const exhausted = runs.filter(r => r.decision === "infra_exhausted").map(r => r.id);
  const out = { set, planned: planned.length, archived: runs.length, counts, missing: missing.length, infra_exhausted: exhausted.length };
  if (values.complete) Object.assign(out, { missing_ids: missing, infra_exhausted_ids: exhausted });
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  // a set or track with nothing planned is not complete
  return values.complete && (!planned.length || missing.length || exhausted.length) ? 1 : 0;
}

async function cmdAudit(argv) {
  const { values } = parseArgs({ args: argv, options: { set: { type: "string" }, all: { type: "boolean" }, requeue: { type: "boolean" }, restore: { type: "boolean" } } });
  const set = requireSet(values);
  if (!values.all) throw new Error("crb audit re-audits archives: pass --all");
  // flags the current rules drop first (a narrowed rule), then flags they add
  const restore = restoreUnflagged(set, { apply: values.restore });
  const res = reauditSet(set, { requeue: values.requeue });
  process.stdout.write(JSON.stringify({ ...res, restorable: restore.restored, restored: values.restore ? restore.restored : [], needs_rerun: restore.needs_rerun }, null, 2) + "\n");
  // a flagged run that is neither contaminated nor sent back to run again is still open
  const handled = new Set([...res.requeued, ...res.newly_contaminated]);
  const open = res.runs.some(r => r.class !== "contaminated" && !handled.has(r.id));
  return open || restore.needs_rerun.length || (!values.restore && restore.restored.length) ? 1 : 0;
}

/** `validate --repo R --stats` (or --all): each repo's tasks against the F8 quotas, without running oracles. */
function validateStats(values, corpus) {
  const repos = values.repo ? [values.repo] : values.all ? listRepoTasks(corpus) : [];
  if (!repos.length) throw new Error("--stats needs --repo <repo> or --all");
  const out = [];
  for (const repo of repos) {
    const dirs = listTasks({ corpus, repo });
    if (!dirs.length) throw new Error(`no tasks for repo ${repo} (corpus ${corpus})`);
    const tasks = dirs.map(d => loadTask(d, { corpus }));
    out.push({ repo, ...quotaStats(tasks, QUOTAS) });
  }
  process.stdout.write(JSON.stringify(out.length === 1 ? out[0] : out, null, 2) + "\n");
  return out.every(r => r.ok) ? 0 : 1;
}

const listRepoTasks = corpus => {
  const d = path.join(corpus, "tasks");
  return fs.existsSync(d) ? fs.readdirSync(d).filter(n => fs.statSync(path.join(d, n)).isDirectory()).sort() : [];
};

async function cmdValidate(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { repo: { type: "string" }, all: { type: "boolean" }, realbugs: { type: "boolean" }, json: { type: "boolean" }, stats: { type: "boolean" } },
  });
  const corpus = corpusRoot();
  if (values.stats) return validateStats(values, corpus);
  const dirs = positionals.length ? positionals : listTasks({ corpus, repo: values.repo, all: values.all, realbugs: values.realbugs });
  if (!dirs.length) {
    process.stderr.write(`no tasks found (corpus ${corpus})\n${USAGE}`);
    return 2;
  }
  let worst = 0;
  const all = [];
  for (const dir of dirs) {
    const res = await validateTask(dir, { corpus, services: taskServices });
    worst = Math.max(worst, res.exitCode);
    all.push({ dir, ok: res.ok, exitCode: res.exitCode, results: res.results });
    if (!values.json) {
      process.stdout.write(`${res.ok ? "PASS" : "FAIL"} ${dir}\n`);
      for (const r of res.results) process.stdout.write(`  ${r.ok ? "ok  " : "FAIL"} ${r.oracle} ${r.detail.split("\n")[0]}\n`);
      for (const r of res.results.filter(x => !x.ok)) {
        const rest = r.detail.split("\n").slice(1).join("\n");
        if (rest) process.stdout.write(`${rest.replace(/^/gm, "       ")}\n`);
      }
    }
  }
  if (values.json) process.stdout.write(JSON.stringify(all, null, 2) + "\n");
  return worst;
}

/** Corpus repos (repos/<name> with crb-repo.json): one by name, or all with --all. */
function selectRepos(positionals, all) {
  const reposDir = path.join(corpusRoot(), "repos");
  const names = all
    ? (fs.existsSync(reposDir) ? fs.readdirSync(reposDir).filter(n => fs.existsSync(path.join(reposDir, n, "crb-repo.json"))).sort() : [])
    : positionals;
  if (!names.length) throw new Error(`name a repo or pass --all (corpus ${corpusRoot()})`);
  for (const n of names) if (!fs.existsSync(path.join(reposDir, n, "crb-repo.json"))) throw new Error(`no repo ${n} with crb-repo.json in ${reposDir}`);
  return names.map(n => path.join(reposDir, n));
}

async function cmdServices(argv) {
  const [action] = argv;
  const fns = { up, down, status: servicesStatus };
  if (!fns[action]) throw new Error("crb services up|down|status");
  const out = await fns[action]();
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  if (action === "status") return out.colima === "running" && out["crb-postgres"].healthy && out["crb-redis"].healthy ? 0 : 1;
  return 0;
}

async function cmdCache(argv) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { all: { type: "boolean" }, realbugs: { type: "boolean" } } });
  const [action, ...repos] = positionals;
  if (action !== "warm") throw new Error("crb cache warm <repo> | --all | --realbugs [<id>...]");
  // a real bug carries its own repo/, and its tasks name the bug id as their repo (node_modules key)
  const targets = values.realbugs
    ? listTasks({ realbugs: true }).filter(d => !repos.length || repos.includes(path.basename(d))).map(d => ({ dir: path.join(d, "repo"), repo: path.basename(d) }))
    : selectRepos(repos, values.all).map(dir => ({ dir, repo: path.basename(dir) }));
  if (!targets.length) throw new Error("no real bugs to warm");
  let worst = 0;
  for (const { dir, repo } of targets) {
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, "crb-repo.json"), "utf8"));
    try {
      const res = await warm(dir, cfg, { repo });
      process.stdout.write(`ok   ${res.repo} ${res.steps.map(s => s.step).join(", ") || "nothing to warm"}\n`);
    } catch (e) {
      worst = 1;
      process.stdout.write(`FAIL ${path.basename(dir)} ${e.message}\n`);
    }
  }
  return worst;
}

async function cmdRepoCheck(argv) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { all: { type: "boolean" }, json: { type: "boolean" } } });
  const all = [];
  for (const dir of selectRepos(positionals, values.all)) {
    const res = await checkRepo(dir);
    all.push(res);
    if (!values.json) {
      process.stdout.write(`${res.ok ? "PASS" : "FAIL"} ${res.repo}\n`);
      for (const r of res.results) process.stdout.write(`  ${r.ok ? "ok  " : "FAIL"} ${r.rule} ${r.detail.split("\n")[0]}\n`);
    }
  }
  if (values.json) process.stdout.write(JSON.stringify(all, null, 2) + "\n");
  return all.every(r => r.ok) ? 0 : 1;
}

async function cmdJudge(argv) {
  const { values } = parseArgs({ args: argv, options: { set: { type: "string" }, tasks: { type: "string" }, concurrency: { type: "string", multiple: true, default: [] } } });
  const set = requireSet(values);
  const out = await judgeSet(set, { tasks: values.tasks ? values.tasks.split(",").filter(Boolean) : undefined, concurrency: parseConcurrency(values.concurrency), onEvent: logEvent });
  const queue = syncAuditQueue(set);
  process.stdout.write(JSON.stringify({ ...out, audit_queue: { items: queue.items.length, open: queue.items.filter(i => i.status === "open").length } }, null, 2) + "\n");
  return out.failed || out.infra_exhausted ? 1 : 0;
}

async function cmdPool(argv) {
  const { values } = parseArgs({ args: argv, options: { set: { type: "string" }, concurrency: { type: "string" } } });
  const set = requireSet(values);
  const concurrency = values.concurrency === undefined ? 1 : Number(values.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error(`--concurrency ${values.concurrency}: must be a positive integer`);
  const out = await poolSet(set, { concurrency });
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  return out.errors.length ? 1 : 0;
}

async function cmdAuditQueue(argv) {
  const { values, positionals } = parseArgs({
    args: argv, allowPositionals: true,
    options: {
      set: { type: "string" }, verdict: { type: "string" }, match: { type: "string" }, evidence: { type: "string" },
      "repro-cmd": { type: "string" }, result: { type: "string" },
      file: { type: "string" }, lines: { type: "string" }, severity: { type: "string" }, summary: { type: "string" },
    },
  });
  const set = requireSet(values);
  const [action, item] = positionals;
  if (action === "status") {
    const s = queueStatus(set);
    process.stdout.write(JSON.stringify(s, null, 2) + "\n");
    return s.open ? 1 : 0;
  }
  if (action === "next") {
    const it = await nextItem(set);
    process.stdout.write(JSON.stringify(it ?? { item: null, open: 0 }, null, 2) + "\n");
    return 0;
  }
  if (action === "show") {
    if (!item) throw new Error("crb audit-queue show <item> --set S");
    process.stdout.write(JSON.stringify(await showItem(set, item), null, 2) + "\n");
    return 0;
  }
  if (action === "record") {
    if (!item) throw new Error("crb audit-queue record <item> --set S --verdict …");
    let lines;
    if (values.lines) {
      const m = values.lines.match(/^(\d+)(?:-(\d+))?$/);
      if (!m) throw new Error("--lines must look like 12-18 or 12");
      lines = [Number(m[1]), Number(m[2] ?? m[1])];
    }
    const rec = recordVerdict(set, item, {
      verdict: values.verdict, match: values.match ? values.match.split(",").map(s => s.trim()) : [], evidence: values.evidence,
      reproCmd: values["repro-cmd"], result: values.result, file: values.file, lines, severity: values.severity, summary: values.summary,
    });
    process.stdout.write(JSON.stringify({ recorded: rec.item, verdict: rec.verdict, match: rec.match, pooled: rec.pooled ?? null }, null, 2) + "\n");
    return 0;
  }
  throw new Error("crb audit-queue next|show|status|record --set S");
}

async function cmdScore(argv) {
  const { values } = parseArgs({ args: argv, options: { set: { type: "string" } } });
  const set = requireSet(values);
  const out = scoreSet(set);
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  return 0;
}

async function cmdRealbugs(argv) {
  const [action, ...rest] = argv;
  if (action === "mine") {
    const { values } = parseArgs({
      args: rest,
      options: {
        since: { type: "string", default: SINCE }, langs: { type: "string", default: "ts,py,go,java" }, "min-stars": { type: "string", default: "1000" },
        pages: { type: "string", default: "3" }, all: { type: "boolean" }, "by-repo": { type: "boolean" }, "max-size-kb": { type: "string", default: "200000" },
        "per-repo": { type: "string" },
      },
    });
    const out = await mine({
      since: values.since, langs: values.langs.split(",").filter(Boolean), minStars: Number(values["min-stars"]), pages: Number(values.pages),
      byRepo: Boolean(values["by-repo"]), maxSizeKb: Number(values["max-size-kb"]),
      perRepo: values["per-repo"] ? Number(values["per-repo"]) : Infinity, log: l => process.stderr.write(`${l}\n`),
    });
    if (!values.all) out.candidates = out.candidates.filter(c => c.ok);
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    return 0;
  }
  if (action === "intro") {
    const { values } = parseArgs({ args: rest, options: { "repo-dir": { type: "string" }, fix: { type: "string" }, repo: { type: "string" }, lang: { type: "string" } } });
    for (const k of ["repo-dir", "fix", "repo", "lang"]) if (!values[k]) throw new Error(`--${k} is required`);
    const out = await findIntro({ repoDir: values["repo-dir"], fix: values.fix, repo: values.repo, lang: values.lang });
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    return 0;
  }
  if (action === "order") {
    const [file] = rest;
    if (!file) throw new Error("crb realbugs order <mine.json>");
    const { candidates } = JSON.parse(fs.readFileSync(file, "utf8"));
    process.stdout.write(`${JSON.stringify(selectionOrder(candidates), null, 2)}\n`);
    return 0;
  }
  throw new Error("crb realbugs mine | order | intro");
}

/** Phase 18 split: per repository, stratified by kind, seeded; real bugs public. */
async function cmdSplit(argv) {
  const { values } = parseArgs({ args: argv, options: { write: { type: "boolean" } } });
  const corpus = corpusRoot();
  const read = d => JSON.parse(fs.readFileSync(path.join(d, "task.json"), "utf8"));
  const repos = {};
  for (const d of listTasks({ corpus, all: true })) {
    const t = read(d);
    (repos[t.repo] ??= []).push({ id: t.id, kind: t.kind });
  }
  const realbugs = listTasks({ corpus, realbugs: true }).map(d => read(d).id);
  const out = makeSplits({ repos, realbugs });
  const problems = Object.entries(out.repos).flatMap(([r, s]) => checkSplit(s, repos[r]).map(p => `${r}: ${p}`));
  if (problems.length) throw new Error(`split is not stratified:\n${problems.join("\n")}`);
  const json = `${JSON.stringify(out, null, 2)}\n`;
  if (values.write) fs.writeFileSync(path.join(corpus, "splits.json"), json);
  process.stdout.write(values.write ? `wrote ${path.join(corpus, "splits.json")}: ${out.public.length} public, ${out.private.length} private\n` : json);
  return 0;
}

/** Track C task list (F11): 40 testable buggy tasks, by seed, over repositories and difficulties. */
async function cmdTrackcTasks(argv) {
  const { values } = parseArgs({ args: argv, options: { write: { type: "boolean" } } });
  const corpus = corpusRoot();
  const repos = {};
  for (const d of listTasks({ corpus, all: true })) {
    const t = JSON.parse(fs.readFileSync(path.join(d, "task.json"), "utf8"));
    (repos[t.repo] ??= []).push({ id: t.id, kind: t.kind, bugs: t.bugs.map(b => ({ difficulty: b.difficulty, testable: b.testable })) });
  }
  const picked = pickTrackC(repos);
  const repoOf = Object.fromEntries(Object.entries(repos).flatMap(([r, ts]) => ts.map(t => [t.id, r])));
  const lines = [`# Track C tasks: pickTrackC, seed ${SPLIT_SEED}, ${picked.length} tasks`, ...picked.map(id => `${repoOf[id]}/${id}`)];
  const text = `${lines.join("\n")}\n`;
  if (values.write) {
    const file = path.join(BENCH_ROOT, "trackc", "tasks.txt");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    process.stdout.write(`wrote ${file}: ${picked.length} tasks\n`);
  } else process.stdout.write(text);
  return 0;
}

/** Phase 22: the report's and article's leaderboard tables against results/leaderboard.json. */
async function cmdCheckReport(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      report: { type: "string", default: path.join(BENCH_ROOT, "report", "REPORT.md") },
      article: { type: "string", default: path.join(BENCH_ROOT, "report", "ARTICLE.md") },
      leaderboard: { type: "string", default: path.join(BENCH_ROOT, "results", "leaderboard.json") },
    },
  });
  const lb = JSON.parse(fs.readFileSync(values.leaderboard, "utf8"));
  const files = [values.report, values.article].map(f => ({ name: path.relative(process.cwd(), f) || f, text: fs.readFileSync(f, "utf8") }));
  const out = checkReport(files, lb);
  if (out.problems.length) {
    process.stderr.write(`${out.problems.join("\n")}\n${out.problems.length} mismatch(es) in ${out.tables} table(s)\n`);
    return 1;
  }
  process.stdout.write(`report numbers match leaderboard.json: ${out.tables} tables, ${out.cells} cells\n`);
  return 0;
}

/** Phase 22: the release bundle; the git e-mail addresses in use and the home path must not appear. */
async function cmdExport(argv) {
  const { values } = parseArgs({ args: argv, options: { out: { type: "string" }, set: { type: "string", default: "final" } } });
  if (!values.out) throw new Error("--out is required");
  const corpus = corpusRoot();
  const email = args => {
    try {
      return execFileSync("git", [...args, "config", "user.email"], { encoding: "utf8" }).trim();
    } catch {
      return "";
    }
  };
  const deny = [...new Set([email([]), email(["-C", corpus]), email(["-C", BENCH_ROOT])].filter(Boolean))];
  const out = exportBundle({ out: path.resolve(values.out), corpus, bench: BENCH_ROOT, runs: path.join(crbHome(), "runs"), set: values.set, home: realHome(), deny });
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  return 0;
}

const COMMANDS = { export: cmdExport, "check-report": cmdCheckReport, "trackc-tasks": cmdTrackcTasks, split: cmdSplit, realbugs: cmdRealbugs, judge: cmdJudge, pool: cmdPool, "audit-queue": cmdAuditQueue, score: cmdScore, validate: cmdValidate, run: cmdRun, trackc: cmdTrackc, status: cmdStatus, audit: cmdAudit, services: cmdServices, cache: cmdCache, "repo-check": cmdRepoCheck };

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const fn = COMMANDS[cmd];
  if (!fn) {
    process.stderr.write(USAGE);
    return 2;
  }
  try {
    return await fn(rest);
  } catch (e) {
    process.stderr.write(`crb ${cmd}: ${e.message}\n`);
    return 2;
  }
}

process.exitCode = await main();
