import { test } from "node:test";
import assert from "node:assert/strict";
import { splitRepo, makeSplits, checkSplit, pickTrackC, SPLIT_SEED } from "../lib/split.js";

// a repository as the corpus has them: 11 buggy, 3 clean, 2 decoy
const repo = name => [
  ...Array.from({ length: 11 }, (_, i) => ({ id: `${name}-T${String(i + 1).padStart(2, "0")}`, kind: "buggy" })),
  ...[12, 13, 14].map(i => ({ id: `${name}-T${i}`, kind: "clean" })),
  ...[15, 16].map(i => ({ id: `${name}-T${i}`, kind: "decoy" })),
];
const count = (ids, tasks, kind) => tasks.filter(t => t.kind === kind && ids.includes(t.id)).length;

test("the split is deterministic and does not depend on the order tasks are listed in", () => {
  const tasks = repo("alpha-ts");
  const a = splitRepo(tasks);
  const b = splitRepo([...tasks].reverse());
  assert.deepEqual(a, b);
  assert.deepEqual(splitRepo(tasks, { seed: SPLIT_SEED }), a);
});

test("every repository splits 8/8 with each kind within one of an even split", () => {
  for (const name of ["alpha-ts", "beta-py", "gamma-go", "delta-java", "eps-ts", "zeta-py"]) {
    const tasks = repo(name);
    const s = splitRepo(tasks);
    assert.equal(s.public.length, 8, name);
    assert.equal(s.private.length, 8, name);
    assert.deepEqual([...s.public, ...s.private].sort(), tasks.map(t => t.id).sort(), name);
    for (const kind of ["buggy", "clean", "decoy"]) assert.ok(Math.abs(count(s.public, tasks, kind) - count(s.private, tasks, kind)) <= 1, `${name} ${kind}`);
    assert.deepEqual(checkSplit(s, tasks), []);
  }
});

test("the seed decides which tasks go public, and both odd kinds' extra task can land on either side", () => {
  const tasks = repo("alpha-ts");
  const seen = new Set();
  const extra = new Set();
  for (let i = 0; i < 40; i++) {
    const s = splitRepo(tasks, { seed: `seed-${i}` });
    seen.add(s.public.join(","));
    extra.add(`${count(s.public, tasks, "buggy")}/${count(s.public, tasks, "clean")}`);
  }
  assert.ok(seen.size > 30, `only ${seen.size} distinct splits from 40 seeds`);
  assert.deepEqual([...extra].sort(), ["5/2", "6/1"]);
});

test("checkSplit rejects a split that is not stratified by kind or not 8/8", () => {
  const tasks = repo("alpha-ts");
  // a plain random split can put every clean task on one side
  const lopsided = { public: ["alpha-ts-T12", "alpha-ts-T13", "alpha-ts-T14", "alpha-ts-T01", "alpha-ts-T02", "alpha-ts-T03", "alpha-ts-T04", "alpha-ts-T05"], private: tasks.map(t => t.id).filter(id => !["alpha-ts-T12", "alpha-ts-T13", "alpha-ts-T14", "alpha-ts-T01", "alpha-ts-T02", "alpha-ts-T03", "alpha-ts-T04", "alpha-ts-T05"].includes(id)) };
  assert.match(checkSplit(lopsided, tasks).join("\n"), /clean: 3 public, 0 private/);
  const uneven = { public: tasks.slice(0, 9).map(t => t.id), private: tasks.slice(9).map(t => t.id) };
  assert.match(checkSplit(uneven, tasks).join("\n"), /9 public, 7 private/);
  const missing = { public: tasks.slice(0, 8).map(t => t.id), private: tasks.slice(8, 15).map(t => t.id) };
  assert.match(checkSplit(missing, tasks).join("\n"), /alpha-ts-T16 is in neither/);
});

test("makeSplits splits each repository on its own and puts every real bug in public", () => {
  const out = makeSplits({ repos: { "alpha-ts": repo("alpha-ts"), "beta-py": repo("beta-py") }, realbugs: ["rb-go-x-1", "rb-ts-y-2"] });
  assert.equal(out.seed, SPLIT_SEED);
  assert.deepEqual(out.repos["alpha-ts"], splitRepo(repo("alpha-ts")));
  assert.deepEqual(out.realbugs, ["rb-go-x-1", "rb-ts-y-2"]);
  assert.equal(out.public.length, 16 + 2);
  assert.equal(out.private.length, 16);
  assert.ok(out.public.includes("rb-ts-y-2") && !out.private.some(id => id.startsWith("rb-")));
});

// buggy tasks with their bugs' difficulty and testability, as task.json gives them
const buggy = (name, specs) => specs.map(([d, testable = true], i) => ({ id: `${name}-T${String(i + 1).padStart(2, "0")}`, kind: "buggy", bugs: [{ difficulty: d, testable }] }));
const corpusOf = names => Object.fromEntries(names.map(n => [n, [
  ...buggy(n, [["L1"], ["L1"], ["L2"], ["L2"], ["L2"], ["L3"], ["L3"], ["L3"], ["L4"], ["L4"], ["L2", false]]),
  { id: `${n}-T12`, kind: "clean", bugs: [] },
]]));

test("Track C takes 40 testable buggy tasks spread over the repositories and difficulties, by seed", () => {
  const repos = corpusOf(["a-ts", "b-ts", "c-ts", "d-py", "e-py", "f-go", "g-go", "h-java", "i-java"]);
  const picked = pickTrackC(repos);
  assert.equal(picked.length, 40);
  assert.deepEqual(pickTrackC(repos), picked);
  const all = Object.values(repos).flat();
  const byId = Object.fromEntries(all.map(t => [t.id, t]));
  for (const id of picked) {
    assert.equal(byId[id].kind, "buggy", id);
    assert.ok(byId[id].bugs.every(b => b.testable), `${id} has an untestable bug`);
  }
  const perRepo = Object.keys(repos).map(r => picked.filter(id => id.startsWith(`${r}-`)).length);
  assert.ok(Math.max(...perRepo) - Math.min(...perRepo) <= 1, `per repository ${perRepo}`);
  for (const r of Object.keys(repos)) {
    const levels = picked.filter(id => id.startsWith(`${r}-`)).map(id => byId[id].bugs[0].difficulty);
    const per = ["L1", "L2", "L3", "L4"].map(l => levels.filter(x => x === l).length);
    assert.ok(Math.max(...per) - Math.min(...per) <= 1, `${r} difficulties ${levels}`);
  }
  assert.notDeepEqual(pickTrackC(repos, { seed: "other" }), picked);
});

test("a task's difficulty for Track C is its hardest bug, and the count is capped by what the corpus has", () => {
  const repos = { "a-ts": [{ id: "a-ts-T01", kind: "buggy", bugs: [{ difficulty: "L1", testable: true }, { difficulty: "L4", testable: true }] }, { id: "a-ts-T02", kind: "buggy", bugs: [{ difficulty: "L4", testable: true }] }] };
  assert.deepEqual(pickTrackC(repos, { count: 40 }).sort(), ["a-ts-T01", "a-ts-T02"]);
  assert.equal(pickTrackC(repos, { count: 1 }).length, 1);
});
