// Per-run scores exactly as Metrics defines them: Track A from round 1 only, Track B outcomes from
// the open round-2 findings, Track C from the loop record. No ratio is stored per run; analysis
// aggregates over tasks. mapping.json (who raised what) is read here and in audit sampling only.

import fs from "node:fs";
import path from "node:path";
import { BENCH_ROOT, gradingDir, corpusRoot } from "../paths.js";
import { SEVERITY_WEIGHT, loadTask } from "../task.js";
import { listRuns, writeAtomic } from "../store.js";
import { overlaps } from "../scenarios.js";
import { scoredRuns, taskDir, writeJson, readJson } from "./collect.js";
import { locationOverlaps } from "./prefilter.js";
import { resolveFindings } from "./verdicts.js";
import { judgesFor, judgmentFile, taskPanel } from "./judge.js";
import { loadEntryTask, loadFindings, collectFindings, contentHash } from "./collect.js";
import { readRecords, cohenKappa, queueStatus } from "./auditq.js";
import { poolCandidates } from "./pool.js";
import { runOutputTokens } from "./tokens.js";

const weightOf = t => SEVERITY_WEIGHT[t.severity] ?? 0;

/**
 * One Track A run's score. findings: its round-1 findings as [{ key, locations }]; verdicts: final
 * verdicts by key; targets: the task's pool (planted + confirmed pooled bugs) by id.
 */
export function scoreRun(run, findings, verdicts, targets) {
  const pool = [...targets.values()];
  const valid = findings.filter(f => verdicts[f.key]?.valid === "real");
  const matchedOf = f => (verdicts[f.key]?.matches ?? []).filter(m => targets.has(m));
  const matched = valid.filter(f => matchedOf(f).length);
  const found = [...new Set(matched.flatMap(matchedOf))].sort();
  const notReal = findings.filter(f => verdicts[f.key]?.valid !== "real");
  const quiet = run.kind === "clean" || run.kind === "decoy";
  return {
    track: "A", set: run.set, run_id: run.id, task: run.task, repo: run.repo, kind: run.kind,
    reviewer: run.reviewer, config: run.config, model: run.model, effort: run.effort, n: run.n, class: run.class,
    tp_weight: found.reduce((s, id) => s + weightOf(targets.get(id)), 0),
    pool_weight: pool.reduce((s, t) => s + weightOf(t), 0),
    findings: findings.length,
    valid: valid.length,
    matched: matched.length,
    matched_locations_ok: matched.filter(f => matchedOf(f).some(id => locationOverlaps(f.locations, targets.get(id)))).length,
    verdict: run.verdict ?? null,
    false_alarm: quiet ? run.verdict === "REVISE" && notReal.length > 0 : null,
    bugs_found: found,
    // the pool's composition, for breakdowns by severity, difficulty and category (pooled bugs have none)
    bugs: pool.map(t => ({ id: t.id, weight: weightOf(t), severity: t.severity, difficulty: t.difficulty ?? null, category: t.category ?? null, pooled: /^P\d+$/.test(t.id) })),
    wall_s: run.wall_s ?? null,
    provisional: findings.some(f => verdicts[f.key]?.provisional),
  };
}

/**
 * One Track B run's outcome (Metrics), from its open round-2 findings: B1 no finding matches a
 * fixed bug; B2 one matches a wrongly fixed bug; B3 one still matches the disputed bug; B4 none
 * matches the disputed decoy. `n/a` without a second round; false when round 2 ended without a
 * usable review (a scored reviewer failure). new_valid_round2 counts valid round-2 findings that
 * match no item a round-1 finding of the run matched and point within ±5 lines of no round-1 finding.
 */
export function scoreTrackB(run, round1, round2, verdicts) {
  const tb = run.track_b;
  const base = { track: "B", set: run.set, run_id: run.id, task: run.task, repo: run.repo, kind: run.kind, reviewer: run.reviewer, config: run.config, n: run.n, scenario: tb?.scenario ?? null };
  if (!tb || tb.status !== "run") return { ...base, outcome: "n/a", new_valid_round2: 0 };
  if (tb.class !== "ok") return { ...base, outcome: false, round2_class: tb.class, new_valid_round2: 0 };
  const hits = ids => round2.some(f => (verdicts[f.key]?.matches ?? []).some(m => ids.includes(m)));
  const outcome = {
    B1: !hits(tb.fixed_bugs), B2: hits(tb.fixed_bugs), B3: hits(tb.disputed), B4: !hits(tb.disputed),
  }[tb.scenario];
  const seen = new Set(round1.flatMap(f => verdicts[f.key]?.matches ?? []));
  const near = f => round1.some(g => g.locations.some(l => l.file && l.start != null && overlaps({ location: f.location }, { file: l.file, lines: [l.start, l.end] })));
  const fresh = round2.filter(f => verdicts[f.key]?.valid === "real" && !(verdicts[f.key].matches ?? []).some(m => seen.has(m)) && !near(f));
  return { ...base, outcome, new_valid_round2: fresh.length, provisional: round2.some(f => verdicts[f.key]?.provisional) };
}

/** One Track C loop's record (Metrics: bugs fixed, regression, rounds, wall time). */
export function scoreLoop(run, task) {
  const fixed = run.bugs_fixed ?? [];
  return {
    track: "C", set: run.set, run_id: run.id, task: run.task, repo: run.repo, kind: run.kind, orchestrator: run.orchestrator, cell: run.cell, class: run.class,
    bugs: task.bugs.length, bugs_testable: run.bugs_testable ?? null, bugs_fixed: fixed,
    fixed_weight: task.bugs.filter(b => fixed.includes(b.id)).reduce((s, b) => s + weightOf(b), 0),
    testable_weight: task.bugs.filter(b => b.testable).reduce((s, b) => s + weightOf(b), 0),
    regression: run.visible_ok === false, visible_ok: run.visible_ok ?? null,
    review_rounds: run.review_rounds ?? 0, sessions: run.sessions ?? 0, reviewers_used: run.reviewers_used ?? [], wall_s: run.wall_s ?? null,
  };
}

/**
 * Agreement (Cohen's kappa on real / not real / unsettled) between the audit and the panel, and
 * between the audit and each judge, over the sampled audit items; overall and per reviewer.
 */
export function agreement(set, mapping, panel) {
  const sampled = readRecords(set).filter(r => r.kind === "finding");
  const judges = judgesFor(set);
  const cache = new Map();
  const readJudgmentValid = (task, judge, key) => {
    const f = judgmentFile(set, task, judge);
    if (!cache.has(f)) cache.set(f, readJson(f));
    return cache.get(f)?.judgments?.[key]?.valid ?? null;
  };
  const label = v => (v === "real" || v === "not_real" ? v : "unsettled");
  const out = { set, items: 0, overall: {}, by_reviewer: {} };
  const groups = { overall: [] };
  for (const r of sampled) {
    for (const key of r.keys) {
      const rev = mapping[key]?.reviewer ?? "?";
      const p = panel[r.task]?.[key];
      const row = { audit: r.verdict, panel: label(p?.valid), judges: Object.fromEntries(judges.map(j => [j.name, label(readJudgmentValid(r.task, j.name, key))])), sample: true };
      groups.overall.push(row);
      (groups[rev] ??= []).push(row);
    }
  }
  const summarize = rows => ({
    n: rows.length,
    panel: cohenKappa(rows.map(x => [x.audit, x.panel])),
    ...Object.fromEntries(judges.map(j => [j.name, cohenKappa(rows.map(x => [x.audit, x.judges[j.name]]))])),
  });
  out.items = groups.overall.length;
  out.overall = summarize(groups.overall);
  for (const [rev, rows] of Object.entries(groups)) if (rev !== "overall") out.by_reviewer[rev] = summarize(rows);
  return out;
}

/**
 * `crb score --set S`: score every scored run of the set and write scores.jsonl and agreement.json
 * in the grading dir; for set `final` also results/scores.jsonl, results/agreement.json and
 * results/pool.json (pooled bugs: id, task, severity) in the bench. Set `final` refuses while grading is unfinished: open audit items, confirmed pooled bugs not
 * re-checked yet, pool candidates not queued yet (run `crb pool`), or provisional rows. Resolves a summary.
 */
export function scoreSet(set, { corpus = corpusRoot(), resultsDir = path.join(BENCH_ROOT, "results") } = {}) {
  const q = queueStatus(set);
  if (set === "final" && q.open) throw new Error(`${q.open} audit item(s) are open; record them before scoring the final set (crb audit-queue next --set final)`);
  let resolved = { tasks: {}, mapping: {}, pool: [], verdicts: {} };
  if (fs.existsSync(path.join(gradingDir(set), "findings.json"))) {
    // the grading is of the findings as collected: an archive replaced since then is not graded yet
    const stored = loadFindings(set).tasks;
    const fresh = collectFindings(set, { corpus, write: false }).tasks;
    const hash = t => contentHash(t?.findings ?? []);
    const changed = [...new Set([...Object.keys(stored), ...Object.keys(fresh)])].filter(id => hash(stored[id]) !== hash(fresh[id]));
    if (changed.length) throw new Error(`the findings of ${changed.join(", ")} changed since they were collected; run \`crb judge --set ${set}\` first`);
    resolved = resolveFindings(set, { corpus });
  }
  const { tasks, mapping, pool, verdicts } = resolved;
  const taskCache = new Map();
  const getTask = run => {
    const dir = taskDir(run, corpus);
    if (!taskCache.has(dir)) taskCache.set(dir, loadTask(dir, { corpus }));
    return taskCache.get(dir);
  };
  // leave-one-judge-out (3+ judges): each finding re-resolved with that judge's votes removed from the
  // panel and the pooled-bug re-checks; the remaining judges must agree (a split is not valid and
  // matches nothing) unless an audit decided it
  const judges = judgesFor(set);
  const loo = {};
  if (judges.length >= 3 && Object.keys(tasks).length) {
    for (const j of judges) {
      const rest = judges.filter(x => x !== j);
      const panel = Object.fromEntries(Object.entries(tasks).filter(([, e]) => e.findings.length).map(([id, e]) => [id, taskPanel(set, id, e, loadEntryTask(e, corpus), rest)]));
      loo[j.name] = resolveFindings(set, { corpus, panel, judges: rest.map(x => x.name) }).verdicts;
    }
  }
  const rows = [];
  for (const run of scoredRuns(set)) {
    const findings = (tasks[run.task]?.findings ?? []).filter(f => verdictsKeyRun(f.key) === run.id);
    if (run.class === "ok" && (run.issues ?? 0) > 0 && !findings.length) throw new Error(`findings of ${run.id} are not collected or judged yet: run \`crb judge --set ${set}\` first`);
    const task = getTask(run);
    const targets = new Map([...(task.bugs ?? []), ...pool.filter(p => p.task === run.task)].map(t => [t.id, t]));
    const r1 = findings.filter(f => f.round === 1);
    const language = task.repoConfig?.language ?? null;
    const row = { ...scoreRun(run, r1, verdicts, targets), language, output_tokens: runOutputTokens(run) };
    if (Object.keys(loo).length) {
      row.loo_judge = Object.fromEntries(Object.entries(loo).map(([name, v]) => {
        const s = scoreRun(run, r1, v, targets);
        return [name, { tp_weight: s.tp_weight, valid: s.valid, matched: s.matched }];
      }));
    }
    rows.push(row);
    if (run.track_b) rows.push({ ...scoreTrackB(run, r1, findings.filter(f => f.round === 2), verdicts), language });
  }
  for (const run of listRuns(set).filter(r => r.track === "C" && r.final === true && r.class !== "contaminated")) {
    const task = getTask(run);
    rows.push({ ...scoreLoop(run, task), language: task.repoConfig?.language ?? null });
  }
  if (set === "final") {
    const unchecked = pool.filter(b => !b.rechecked).map(b => b.id);
    if (unchecked.length) throw new Error(`pooled bug(s) ${unchecked.join(", ")} are not re-checked yet: run \`crb pool --set final\``);
    const candidates = Object.values(poolCandidates(set, { corpus })).reduce((n, c) => n + c.findings.length, 0);
    if (candidates) throw new Error(`${candidates} pool candidate(s) are not queued yet: run \`crb pool --set final\``);
    const provisional = rows.filter(r => r.provisional).length;
    if (provisional) throw new Error(`${provisional} row(s) are provisional (findings not judged or not settled): run \`crb judge --set final\` and finish the audit`);
  }
  const text = rows.map(r => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
  const agree = agreement(set, mapping, readJson(path.join(gradingDir(set), "panel.json"), {}));
  writeAtomic(path.join(gradingDir(set), "scores.jsonl"), text);
  writeJson(path.join(gradingDir(set), "agreement.json"), agree);
  if (set === "final") {
    writeAtomic(path.join(resultsDir, "scores.jsonl"), text);
    writeJson(path.join(resultsDir, "agreement.json"), agree);
    // pooled bugs without their answer text, which private tasks must not publish
    writeJson(path.join(resultsDir, "pool.json"), { set, bugs: pool.map(b => ({ id: b.id, task: b.task, severity: b.severity })) });
  }
  return {
    set, rows: rows.length, track_a: rows.filter(r => r.track === "A").length, track_b: rows.filter(r => r.track === "B").length, track_c: rows.filter(r => r.track === "C").length,
    provisional: rows.filter(r => r.provisional).length, open_audit_items: q.open, pooled_bugs: pool.length,
    file: path.join(gradingDir(set), "scores.jsonl"),
  };
}

/** The run id a finding key belongs to (`<run id>#r<round>#<issue>`). */
export function verdictsKeyRun(key) {
  return key.split("#")[0];
}
