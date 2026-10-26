// Location prefilter: which answer-key items (bugs, decoys, pooled bugs) a finding could be about,
// judged by where it points. It never decides a match; it narrows what a re-check sends to the
// judges, and it measures location accuracy for scores.

import { sameFile } from "../scenarios.js";

/** Slack of the prefilter's `near` (lines around a target). */
export const PREFILTER_SLACK = 10;
/** Location accuracy (Metrics): a matched finding's location within ±3 lines of the matched item. */
export const LOCATION_SLACK = 3;

/** True when one of locs names target's file within slack lines of its lines. */
export function locationOverlaps(locs, target, slack = LOCATION_SLACK) {
  const [s, e] = target.lines;
  return (locs ?? []).some(l => l.file && l.start != null && sameFile(l.file, target.file) && l.start <= e + slack && l.end >= s - slack);
}

/**
 * For a finding (with `locations` from normalize) and answer-key targets ({ id, file, lines }):
 *   near      ids whose file it names within PREFILTER_SLACK lines
 *   same_file ids whose file it names (any line, or none)
 *   unknown   true when it names no file
 *   candidates same_file, or every id when it names no file: what a judge must still look at
 */
export function prefilter(finding, targets, { slack = PREFILTER_SLACK } = {}) {
  const locs = (finding.locations ?? []).filter(l => l.file);
  const unknown = locs.length === 0;
  const sameFileIds = targets.filter(t => locs.some(l => sameFile(l.file, t.file))).map(t => t.id);
  const near = targets.filter(t => locationOverlaps(locs, t, slack)).map(t => t.id);
  return { near, same_file: sameFileIds, unknown, candidates: unknown ? targets.map(t => t.id) : sameFileIds };
}

/** The findings that could be about target: they name its file, or no file at all. */
export function findingsFor(findings, target) {
  return findings.filter(f => prefilter(f, [target]).candidates.length > 0);
}
