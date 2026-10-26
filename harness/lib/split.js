// Public/private split of the corpus (Phase 18): per repository, stratified by task kind, seeded.
import crypto from "node:crypto";

export const SPLIT_SEED = "20261017";

const rank = (seed, key) => crypto.createHash("sha256").update(`${seed}:${key}`).digest("hex");
const bySeed = (seed, key = x => x) => (a, b) => (rank(seed, key(a)) < rank(seed, key(b)) ? -1 : 1);

/**
 * One repository's split, from `[{id, kind}]`: half of each kind goes public, in the seeded order of
 * its task IDs; kinds with an odd count give their extra task to whichever side keeps the
 * repository even, chosen in the seeded order of the kinds.
 */
export function splitRepo(tasks, { seed = SPLIT_SEED } = {}) {
  const kinds = [...new Set(tasks.map(t => t.kind))].sort();
  const groups = Object.fromEntries(kinds.map(k => [k, tasks.filter(t => t.kind === k).map(t => t.id).sort(bySeed(seed))]));
  const take = Object.fromEntries(kinds.map(k => [k, Math.floor(groups[k].length / 2)]));
  let need = Math.floor(tasks.length / 2) - Object.values(take).reduce((a, b) => a + b, 0);
  for (const k of kinds.filter(k => groups[k].length % 2).sort(bySeed(seed, k => `kind:${k}`))) {
    if (need-- <= 0) break;
    take[k]++;
  }
  const pub = kinds.flatMap(k => groups[k].slice(0, take[k]));
  const priv = kinds.flatMap(k => groups[k].slice(take[k]));
  return { public: pub.sort(), private: priv.sort() };
}

/** Problems with a repository's split: not half and half, a kind off by more than one, a task missing or on both sides. */
export function checkSplit(split, tasks) {
  const problems = [];
  const pub = new Set(split.public);
  const priv = new Set(split.private);
  for (const t of tasks) {
    if (pub.has(t.id) && priv.has(t.id)) problems.push(`${t.id} is in both`);
    else if (!pub.has(t.id) && !priv.has(t.id)) problems.push(`${t.id} is in neither`);
  }
  const ids = new Set(tasks.map(t => t.id));
  for (const id of [...pub, ...priv]) if (!ids.has(id)) problems.push(`${id} is not a task of the repository`);
  if (Math.abs(pub.size - priv.size) > 1) problems.push(`${pub.size} public, ${priv.size} private`);
  for (const kind of [...new Set(tasks.map(t => t.kind))].sort()) {
    const of = s => tasks.filter(t => t.kind === kind && s.has(t.id)).length;
    if (Math.abs(of(pub) - of(priv)) > 1) problems.push(`${kind}: ${of(pub)} public, ${of(priv)} private`);
  }
  return problems;
}

/** The corpus split: `repos` maps each repository to its `[{id, kind}]`; every real bug is public. */
export function makeSplits({ repos, realbugs = [], seed = SPLIT_SEED }) {
  const perRepo = Object.fromEntries(Object.keys(repos).sort().map(r => [r, splitRepo(repos[r], { seed })]));
  const rb = [...realbugs].sort();
  return {
    seed,
    method: "per repository, stratified by task kind, ordered by sha256(seed:task id); real bugs are public",
    repos: perRepo,
    realbugs: rb,
    public: [...Object.values(perRepo).flatMap(s => s.public), ...rb],
    private: Object.values(perRepo).flatMap(s => s.private),
  };
}

const LEVELS = ["L1", "L2", "L3", "L4"];

/**
 * Track C tasks (F11): `count` buggy tasks whose bugs all have hidden tests. Repositories take turns in
 * the seeded order, one task per turn, so their counts differ by at most one; within a repository the
 * tasks take turns by difficulty (the task's hardest bug), each level in the seeded order of its tasks.
 */
export function pickTrackC(repos, { seed = SPLIT_SEED, count = 40 } = {}) {
  const hardest = t => t.bugs.map(b => b.difficulty).sort().at(-1);
  const queues = {};
  for (const r of Object.keys(repos).sort()) {
    const eligible = repos[r].filter(t => t.kind === "buggy" && t.bugs.length && t.bugs.every(b => b.testable));
    const levels = LEVELS.filter(l => eligible.some(t => hardest(t) === l)).sort(bySeed(seed, l => `${r}:level:${l}`));
    const byLevel = levels.map(l => eligible.filter(t => hardest(t) === l).map(t => t.id).sort(bySeed(seed)));
    const order = [];
    while (byLevel.some(q => q.length)) for (const q of byLevel) if (q.length) order.push(q.shift());
    queues[r] = order;
  }
  const turn = Object.keys(queues).sort(bySeed(seed, r => `repo:${r}`));
  const picked = [];
  while (picked.length < count && turn.some(r => queues[r].length)) {
    for (const r of turn) if (picked.length < count && queues[r].length) picked.push(queues[r].shift());
  }
  return picked.sort();
}
