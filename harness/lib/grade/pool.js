// Pooling (TREC-style, F12): real round-1 findings that match no known bug are grouped by the
// dedupe helper; each group is a pooled-bug candidate for the audit; a confirmed one becomes P<k>,
// and every finding of its task that could be about it (prefilter) is re-checked by the panel, so
// another reviewer that found the same defect is credited too.

import { corpusRoot } from "../paths.js";
import { SEVERITIES } from "../task.js";
import { infraReason } from "../failures.js";
import { readJson, writeJson, loadEntryTask, findingSig } from "./collect.js";
import { render, extractJson, judgeTask, judgesFor, cliInvoke, HELPER, JUDGE_ATTEMPTS } from "./judge.js";
import { findingsFor } from "./prefilter.js";
import { enqueue, readQueue, readPool, poolFile, refreshStaleGrading } from "./auditq.js";
import { resolveFindings, recheckFile } from "./verdicts.js";

/**
 * Round-1 findings judged real that match no bug or pooled bug and are in no pool item yet, by
 * task. A finding still waiting for the audit of a tie or failure waits; one only in the random
 * sample does not (its pool audit settles the sample item too).
 */
export function poolCandidates(set, { corpus = corpusRoot() } = {}) {
  const { tasks, verdicts } = resolveFindings(set, { corpus });
  const queued = new Set(readQueue(set).items.filter(i => i.kind === "pool").flatMap(i => i.keys));
  const out = {};
  for (const [taskId, entry] of Object.entries(tasks)) {
    const task = loadEntryTask(entry, corpus);
    const decoys = new Set((task.decoys ?? []).map(d => d.id));
    const list = entry.findings.filter(f => {
      const v = verdicts[f.key];
      return f.round === 1 && v.valid === "real" && !v.unsettled && !v.matches.some(m => !decoys.has(m)) && !queued.has(f.key);
    });
    if (list.length) out[taskId] = { entry, task, findings: list };
  }
  return out;
}

/** Schema check of a dedupe answer: every candidate in exactly one group with a location, severity and summary. */
export function parseGroups(text, fids) {
  const obj = extractJson(text);
  if (!obj || !Array.isArray(obj.groups)) return { ok: false, error: "no `groups` array" };
  const seen = new Set();
  for (const g of obj.groups) {
    if (!g || !Array.isArray(g.findings) || !g.findings.length) return { ok: false, error: "a group without findings" };
    for (const f of g.findings) {
      if (!fids.includes(f)) return { ok: false, error: `unknown finding ${f}` };
      if (seen.has(f)) return { ok: false, error: `${f} in two groups` };
      seen.add(f);
    }
    if (typeof g.file !== "string" || !g.file.trim()) return { ok: false, error: "a group without a file" };
    if (!Array.isArray(g.lines) || g.lines.length !== 2 || !g.lines.every(Number.isInteger) || g.lines[0] < 1 || g.lines[0] > g.lines[1]) return { ok: false, error: "a group's lines must be [first, last]" };
    if (!SEVERITIES.includes(g.severity)) return { ok: false, error: `severity must be one of ${SEVERITIES.join(", ")}` };
    if (typeof g.summary !== "string" || !g.summary.trim()) return { ok: false, error: "a group without a summary" };
  }
  const missing = fids.filter(f => !seen.has(f));
  if (missing.length) return { ok: false, error: `missing ${missing.join(", ")}` };
  return { ok: true, groups: obj.groups.map(g => ({ findings: g.findings, file: g.file.trim().replace(/^\.\//, ""), lines: g.lines, severity: g.severity, summary: g.summary.trim() })) };
}

/** One group per finding, from its own location, when the helper cannot answer. */
function singletons(findings) {
  return findings.map(f => {
    const loc = f.locations.find(l => l.file && l.start != null) ?? f.locations.find(l => l.file);
    return {
      findings: [f.fid], file: loc?.file ?? null, lines: loc?.start != null ? [loc.start, loc.end] : null,
      severity: SEVERITIES.includes(f.severity) ? f.severity : "medium", summary: f.title || f.problem.slice(0, 200),
    };
  });
}

/** Ask the dedupe helper to group a task's candidates. Throws on an infra fault (rerun later). */
export async function proposeGroups(task, findings, { invoke = cliInvoke } = {}) {
  if (findings.length === 1) return singletons(findings);
  const shown = findings.map(f => ({ id: f.fid, location: f.location, title: f.title, problem: f.problem, evidence: f.evidence, suggested_fix: f.suggested_fix }));
  const prompt = render("dedupe", { TITLE: task.title.trim(), DESCRIPTION: task.description.trim(), FINDINGS: JSON.stringify(shown, null, 2) });
  const fids = findings.map(f => f.fid);
  for (let i = 0; i < JUDGE_ATTEMPTS; i++) {
    const res = await invoke(HELPER, { task, prompt });
    if (res.status !== "completed") {
      const why = infraReason([res.error, res.errorLog].filter(Boolean).join("\n"));
      if (why || ["init_failed", "start_failed", "poll_failed", "failed"].includes(res.status)) throw new Error(`dedupe helper: ${why ?? res.status}`);
      continue;
    }
    if (res.flagged) continue;
    const parsed = parseGroups(res.text, fids);
    if (parsed.ok) return parsed.groups;
  }
  return singletons(findings);
}

/**
 * Re-check one confirmed pooled bug: the task's round-1 findings that could be about it (prefilter),
 * minus its own cluster, go to the panel with the pooled bug as the only answer-key item. A match
 * needs a majority of the judges that answered; an even split or too few answers goes to audit.
 * Returns { checked, matched, audit } or { infra } when a judge could not run.
 */
export async function recheckPooled(set, bug, entry, task, opts = {}) {
  const judged = await judgePooled(set, bug, entry, task, opts);
  return judged.infra ? judged : commitRecheck(set, bug, judged.result);
}

/** The panel's answers on one pooled bug, nothing written: { result } or { infra }. */
async function judgePooled(set, bug, entry, task, { invoke = cliInvoke, judges = judgesFor(set) } = {}) {
  const subset = findingsFor(entry.findings.filter(f => f.round === 1 && !bug.keys.includes(f.key)), bug);
  const result = {};
  if (subset.length) {
    const answers = [];
    for (const judge of judges) {
      const res = await judgeTask(task, subset, judge, { invoke, only: [bug] });
      if (res.status === "infra") return { infra: `${judge.name}: ${res.reason}` };
      answers.push({ ...res, judge: judge.name });
    }
    const ok = answers.filter(a => a.status === "ok");
    const quorum = Math.floor(judges.length / 2) + 1;
    for (const f of subset) {
      const votes = ok.map(a => a.judgments[f.fid]).filter(Boolean);
      const n = votes.length;
      const any = votes.filter(v => v.matches.includes(bug.id)).length;
      // "not real" yet naming the pooled bug is inconsistent, as on the panel: it never counts as a match
      const c = votes.filter(v => v.matches.includes(bug.id) && v.valid !== "not_real").length;
      const why = n < quorum ? "judge_failure" : any * 2 === n ? "tie" : any * 2 > n && c * 2 <= n ? "inconsistent" : null;
      // each judge's vote, so leave-one-judge-out can decide the re-check without the left-out judge
      const byJudge = Object.fromEntries(ok.filter(a => a.judgments[f.fid]).map(a => [a.judge, { valid: a.judgments[f.fid].valid, match: a.judgments[f.fid].matches.includes(bug.id) }]));
      result[f.key] = { match: why ? null : c * 2 > n, votes: n, for: c, judges: byJudge, sig: findingSig(f), ...(why ? { why } : {}) };
    }
  }
  return { result };
}

/** Store one re-check and queue its unsettled matches for audit. */
function commitRecheck(set, bug, result) {
  const all = readJson(recheckFile(set), {});
  all[bug.id] = result;
  writeJson(recheckFile(set), all);
  const unsettled = Object.entries(result).filter(([, v]) => v.match === null);
  if (unsettled.length) enqueue(set, unsettled.map(([key, v]) => ({ kind: "pool_match", task: bug.task, keys: [key], target: bug.id, reasons: [v.why] })));
  return { checked: Object.keys(result).length, matched: Object.values(result).filter(v => v.match === true).length, audit: unsettled.length };
}

/**
 * `crb pool --set S`: re-check every confirmed pooled bug not re-checked yet, then group the new
 * candidates and queue each group for audit. Resolves a summary. `concurrency` pooled bugs are
 * judged at once, but their results are written in pool order (re-check, audit items, `rechecked`),
 * exactly as one at a time: audit resolution depends on queue order. An exception, in judging or
 * writing, starts no further re-check and rejects once those in flight end.
 */
export async function poolSet(set, { invoke, pollMs, corpus = corpusRoot(), judges, concurrency = 1 } = {}) {
  invoke ??= (j, a) => cliInvoke(j, { ...a, pollMs });
  const summary = { set, rechecked: [], groups_queued: 0, candidates: 0, errors: [] };
  // findings that changed since they were graded put their pooled bugs up for a re-check again
  refreshStaleGrading(set);
  const pool = readPool(set);
  const { tasks } = resolveFindings(set, { corpus });
  const todo = pool.bugs.filter(b => !b.rechecked);
  const judged = [];
  let next = 0, written = 0, failed = false;
  const writeReady = () => {
    for (; written < todo.length && judged[written]; written++) {
      const bug = todo[written];
      const j = judged[written];
      if (j.infra) { summary.errors.push(`${bug.id}: ${j.infra}`); continue; }
      const res = commitRecheck(set, bug, j.result);
      const fresh = readPool(set);
      fresh.bugs.find(b => b.id === bug.id).rechecked = true;
      writeJson(poolFile(set), fresh);
      summary.rechecked.push({ id: bug.id, ...res });
    }
  };
  const worker = async () => {
    while (!failed && next < todo.length) {
      const i = next++;
      const bug = todo[i];
      const entry = tasks[bug.task];
      try {
        judged[i] = await judgePooled(set, bug, entry, loadEntryTask(entry, corpus), { invoke, judges: judges ?? judgesFor(set) });
        if (!failed) writeReady();
      } catch (e) {
        failed = true;
        throw e;
      }
    }
  };
  const settled = await Promise.allSettled(Array.from({ length: Math.max(1, Math.min(concurrency, todo.length)) }, worker));
  const thrown = settled.find(s => s.status === "rejected");
  if (thrown) throw thrown.reason;
  for (const [taskId, { task, findings }] of Object.entries(poolCandidates(set, { corpus }))) {
    summary.candidates += findings.length;
    let groups;
    try {
      groups = await proposeGroups(task, findings, { invoke });
    } catch (e) {
      summary.errors.push(`${taskId}: ${e.message}`);
      continue;
    }
    const byFid = new Map(findings.map(f => [f.fid, f.key]));
    enqueue(set, groups.map(g => ({
      kind: "pool", task: taskId, keys: g.findings.map(f => byFid.get(f)), reasons: ["pool_candidate"],
      proposal: { file: g.file, lines: g.lines, severity: g.severity, summary: g.summary },
    })));
    summary.groups_queued += groups.length;
  }
  return summary;
}
