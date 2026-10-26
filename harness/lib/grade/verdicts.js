// The final verdict on every finding: the panel's majority, overridden by an audit record, plus the
// pooled bugs it was confirmed to match (its pool cluster, or the re-check of the task's findings).

import path from "node:path";
import { gradingDir, corpusRoot } from "../paths.js";
import { readJson, loadFindings, loadEntryTask, sigsByKey, staleSig } from "./collect.js";
import { panelFile } from "./judge.js";
import { readQueue, readRecords, readPool } from "./auditq.js";

export const recheckFile = set => path.join(gradingDir(set), "recheck.json");

/** Whether a stored re-check matches: its decision, or, for a subset of judges, their votes alone. */
function recheckMatch(r, judges) {
  if (!r) return false;
  if (!judges) return r.match === true;
  const votes = judges.map(j => r.judges?.[j]).filter(Boolean);
  const c = votes.filter(v => v.match && v.valid !== "not_real").length;
  return votes.length >= Math.floor(judges.length / 2) + 1 && c * 2 > votes.length;
}

/**
 * { tasks, mapping, pool, verdicts } with verdicts[key] = { valid: "real" | "not_real" | null,
 * matches: [ids], provisional, unsettled }. Order, each step overriding the one before: the panel;
 * the panel's re-checks against pooled bugs; the audit of the finding (its validity is final, and a
 * not-real verdict drops every pooled match); the audit of its pool group; the audits of its
 * re-checks. A match with a confirmed pooled bug makes a finding real unless an audit said
 * otherwise; a match with a decoy makes it not real. `provisional` while any open audit item covers
 * the finding; `unsettled` while the panel has not settled it and no audit has, or an open item
 * other than the random sample covers it. Leave-one-judge-out passes `panel` (in place of panel.json)
 * and `judges`, the names of the judges left: a re-check then counts only their stored votes, by the
 * same majority-of-a-quorum rule (two judges must agree); a re-check without per-judge votes matches nothing.
 * A panel entry, re-check or audit record of a finding whose content has changed since (a replaced
 * attempt under the same key) counts for nothing, and the finding is provisional until it is graded again.
 */
export function resolveFindings(set, { corpus = corpusRoot(), panel = readJson(panelFile(set), {}), judges = null } = {}) {
  const { tasks, mapping } = loadFindings(set);
  const recheck = readJson(recheckFile(set), {});
  const pool = readPool(set).bugs;
  const records = readRecords(set);
  const openReasons = new Map();
  for (const i of readQueue(set).items.filter(i => i.status === "open")) {
    for (const k of i.keys) openReasons.set(k, [...(openReasons.get(k) ?? []), ...i.reasons]);
  }
  const sigs = sigsByKey(tasks);
  const verdicts = {};
  for (const [taskId, entry] of Object.entries(tasks)) {
    const task = loadEntryTask(entry, corpus);
    const decoyIds = new Set((task.decoys ?? []).map(d => d.id));
    const taskPool = pool.filter(p => p.task === taskId);
    const pooledIds = new Set(taskPool.map(b => b.id));
    for (const f of entry.findings) {
      const sig = sigs.get(f.key);
      const stored = panel[taskId]?.[f.key];
      const p = stored && !staleSig(stored.sig, sig) ? stored : { valid: null, matches: [], audit: "not_judged" };
      // re-checks and audit records of the finding as it was then, if it has changed since
      const old = [...taskPool.map(b => recheck[b.id]?.[f.key]), ...records.filter(r => r.keys.includes(f.key)).map(r => ({ sig: r.sigs?.[f.key] }))]
        .some(r => staleSig(r?.sig, sig));
      const fresh = r => !staleSig(r.sigs?.[f.key], sig);
      let valid = p.valid;
      let matches = new Set(p.matches);
      let settled = !p.audit;
      let audited = false;
      for (const b of taskPool) if (!staleSig(recheck[b.id]?.[f.key]?.sig, sig) && recheckMatch(recheck[b.id]?.[f.key], judges)) matches.add(b.id);
      for (const r of records.filter(r => r.kind === "finding" && r.keys.includes(f.key) && fresh(r))) {
        const pooled = r.verdict === "real" ? [...matches].filter(m => pooledIds.has(m)) : [];
        valid = r.verdict;
        matches = new Set([...r.match, ...pooled]);
        settled = audited = true;
      }
      for (const r of records.filter(r => r.kind === "pool" && r.keys.includes(f.key) && fresh(r))) {
        valid = r.verdict;
        if (r.verdict === "real") for (const m of r.pooled ? [r.pooled] : r.match) matches.add(m);
        settled = audited = true;
      }
      for (const r of records.filter(r => r.kind === "pool_match" && r.keys.includes(f.key) && fresh(r))) {
        if (r.match.includes(r.target)) matches.add(r.target); else matches.delete(r.target);
        if (r.verdict === "not_real" || r.match.includes(r.target)) valid = r.verdict;
        audited = true;
      }
      if (!audited && [...matches].some(m => pooledIds.has(m))) valid = "real";
      if ([...matches].some(m => decoyIds.has(m))) valid = "not_real";
      const reasons = openReasons.get(f.key) ?? [];
      verdicts[f.key] = {
        task: taskId, round: f.round, valid, matches: [...matches].sort(),
        provisional: !settled || old || reasons.length > 0,
        unsettled: !settled || old || reasons.some(r => r !== "sample"),
      };
    }
  }
  return { tasks, mapping, pool, verdicts };
}
