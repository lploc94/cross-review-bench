// Output tokens per run, a cost proxy (METHODOLOGY "Cost proxies"): the output tokens round 1's
// reviewer reported in its event log, reasoning included, as each CLI reports them. null when the log
// has no usage, so a missing report is never read as zero.

import fs from "node:fs";
import path from "node:path";

const parse = line => {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
};

const count = v => (Number.isFinite(v) ? v : null);

/** Output tokens in one round's event log lines, by reviewer; null without a usage report. */
export function outputTokens(reviewer, lines) {
  const events = lines.map(parse).filter(Boolean);
  let total = null;
  const add = v => {
    if (count(v) !== null) total = (total ?? 0) + v;
  };
  if (reviewer === "claude") {
    // one result event per turn carries the turn's usage; assistant messages carry partial usage
    for (const d of events) if (d.type === "result") add(d.usage?.output_tokens);
  } else if (reviewer === "codex") {
    for (const d of events) if (d.type === "turn.completed") add(d.usage?.output_tokens);
  } else if (reviewer === "agy") {
    // a step may be reported more than once; its last usage stands
    const byStep = new Map();
    for (const d of events) {
      const s = d.event === "step_update" ? d.step_update : null;
      if (s && count(s.usage?.output_tokens) !== null) byStep.set(s.step_index, s.usage.output_tokens);
    }
    for (const v of byStep.values()) add(v);
  }
  return total;
}

/** Round 1's event log in a run archive: the round1/ snapshot when a second round ran, else session/. */
export function roundOneLog(archive) {
  const snap = path.join(archive, "round1", "session", "output.jsonl");
  return fs.existsSync(snap) ? snap : path.join(archive, "session", "output.jsonl");
}

/** Round 1's output tokens of a run ({ archive, reviewer }); null when the log or its usage is missing. */
export function runOutputTokens(run) {
  const file = roundOneLog(run.archive);
  if (!fs.existsSync(file)) return null;
  return outputTokens(run.reviewer, fs.readFileSync(file, "utf8").split("\n"));
}
