import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { judgeCandidate, mine, searchQueries, parseBlame, lineRanges, pickIntro, checkSource, findIntro, selectionOrder } from "../lib/realbugs.js";
import { validateTask } from "../lib/validate.js";

const FX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "realbugs");
const read = f => JSON.parse(fs.readFileSync(path.join(FX, f), "utf8"));
const SINCE = "2026-07-01";

const good = () => ({
  lang: "go",
  repo: { full_name: "acme/tinyq", stars: 4200, license: "Apache-2.0", archived: false },
  pr: { number: 412, title: "fix: retry counter resets after a lease expires", labels: [], merged_at: "2026-08-14T09:12:00Z", author_type: "User" },
  files: [{ filename: "internal/lease/lease.go" }, { filename: "internal/lease/lease_test.go" }],
});

test("a recent permissive fix PR that changes a source file and a test is a candidate", () => {
  assert.deepEqual(judgeCandidate(good(), { since: SINCE, minStars: 1000 }), { ok: true, reasons: [] });
});

test("each filtering rule rejects with its own reason", () => {
  const cases = [
    [c => { c.pr.merged_at = "2026-06-30T23:59:59Z"; }, /fix merged before 2026-07-01/],
    [c => { c.pr.merged_at = null; }, /not merged/],
    [c => { c.repo.stars = 999; }, /fewer than 1000 stars/],
    [c => { c.repo.license = "GPL-3.0"; }, /licence GPL-3.0 is not permissive/],
    [c => { c.repo.license = null; }, /no licence/],
    [c => { c.repo.archived = true; }, /archived/],
    [c => { c.files = [{ filename: "internal/lease/lease.go" }]; }, /changes no test/],
    [c => { c.files = [{ filename: "internal/lease/lease_test.go" }, { filename: "README.md" }]; }, /changes no source file/],
    [c => { c.pr.title = "Handle empty batches"; }, /no fix in the title or a bug label/],
    [c => { c.pr.author_type = "Bot"; }, /bot or dependency update/],
    [c => { c.pr.title = "fix(deps): bump golang.org/x/net"; }, /bot or dependency update/],
  ];
  for (const [edit, reason] of cases) {
    const c = good();
    edit(c);
    const r = judgeCandidate(c, { since: SINCE, minStars: 1000 });
    assert.equal(r.ok, false, String(reason));
    assert.match(r.reasons.join("; "), reason);
  }
});

test("a bug label stands in for fix in the title", () => {
  const c = good();
  c.pr.title = "Handle empty batches in the scheduler";
  c.pr.labels = ["kind/bug"];
  assert.equal(judgeCandidate(c, { since: SINCE, minStars: 1000 }).ok, true);
});

test("vendored, generated and declaration files are not source changes", () => {
  const c = good();
  c.files = [{ filename: "vendor/x/y.go" }, { filename: "internal/lease/lease_test.go" }];
  assert.match(judgeCandidate(c, { since: SINCE, minStars: 1000 }).reasons.join(), /changes no source file/);
  const ts = { ...good(), lang: "ts", files: [{ filename: "src/types.d.ts" }, { filename: "src/pager.test.ts" }] };
  assert.match(judgeCandidate(ts, { since: SINCE, minStars: 1000 }).reasons.join(), /changes no source file/);
});

test("test files are recognised per language", () => {
  const ok = (lang, files) => judgeCandidate({ ...good(), lang, files: files.map(filename => ({ filename })) }, { since: SINCE, minStars: 1000 }).ok;
  assert.equal(ok("ts", ["src/pager.ts", "src/pager.test.ts"]), true);
  assert.equal(ok("ts", ["lib/a.js", "__tests__/a.js"]), true);
  assert.equal(ok("py", ["pkg/mod.py", "tests/test_mod.py"]), true);
  assert.equal(ok("py", ["pkg/mod.py", "pkg/mod_test.py"]), true);
  assert.equal(ok("java", ["core/src/main/java/a/A.java", "core/src/test/java/a/ATest.java"]), true);
  assert.equal(ok("java", ["core/src/main/java/a/A.java", "core/src/main/java/a/B.java"]), false);
});

test("an introducing PR merged before the cutoff rejects the candidate even when the fix is recent", () => {
  const c = good();
  c.intro = { number: 300, merged_at: "2026-05-02T10:00:00Z" };
  const r = judgeCandidate(c, { since: SINCE, minStars: 1000 });
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(), /introducing PR #300 merged before 2026-07-01/);
  c.intro = { number: null, merged_at: null };
  assert.match(judgeCandidate(c, { since: SINCE, minStars: 1000 }).reasons.join(), /introducing change has no merged PR/);
  c.intro = { number: 380, merged_at: "2026-07-15T00:00:00Z" };
  assert.equal(judgeCandidate(c, { since: SINCE, minStars: 1000 }).ok, true);
});

test("search queries ask for merged PRs since the cutoff in the language, by title and by bug label", () => {
  const q = searchQueries("go", SINCE);
  assert.equal(q.length, 2);
  for (const s of q) assert.match(s, /is:pr is:merged merged:>=2026-07-01 language:Go/);
  assert.match(q[0], /fix in:title/);
  assert.match(q[1], /label:bug/);
});

test("mine reads recorded gh api answers, merges duplicates and fetches files only for survivors", async () => {
  const repos = read("repos.json");
  const files = read("files.json");
  const calls = [];
  const gh = async args => {
    calls.push(args.join(" "));
    const q = args.find(a => a.startsWith("q="));
    if (q) return q.includes("label:bug") ? read("search-go-label.json") : read("search-go-title.json");
    const repo = args.find(a => /^repos\/[^/]+\/[^/]+$/.test(a));
    if (repo) return repos[repo.slice("repos/".length)];
    const f = args.find(a => a.includes("/pulls/"));
    const m = f.match(/^repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/files/);
    return [files[`${m[1]}#${m[2]}`]];
  };
  const out = await mine({ since: SINCE, langs: ["go"], minStars: 1000, pages: 1, gh });
  const byPr = Object.fromEntries(out.candidates.map(c => [`${c.repo}#${c.pr}`, c]));
  assert.deepEqual(Object.keys(byPr).sort(), ["acme/small#51", "acme/tinyq#412", "acme/tinyq#430", "acme/tinyq#77", "acme/tinyq#9", "acme/viralcode#1200"]);
  assert.equal(byPr["acme/tinyq#412"].ok, true);
  assert.deepEqual(byPr["acme/tinyq#412"].labels, ["bug"]);
  assert.deepEqual(byPr["acme/tinyq#412"].test_files, ["internal/lease/lease_test.go"]);
  assert.match(byPr["acme/tinyq#77"].reasons.join(), /changes no test/);
  assert.match(byPr["acme/tinyq#9"].reasons.join(), /bot or dependency update/);
  assert.match(byPr["acme/tinyq#430"].reasons.join(), /fix merged before/);
  assert.match(byPr["acme/viralcode#1200"].reasons.join(), /not permissive/);
  assert.match(byPr["acme/small#51"].reasons.join(), /fewer than 1000 stars/);
  // each repository is read once; files only for PRs that pass the cheap rules
  assert.equal(calls.filter(c => c === "repos/acme/tinyq").length, 1);
  const fileCalls = calls.filter(c => c.includes("/files"));
  assert.deepEqual(fileCalls.map(c => c.match(/pulls\/(\d+)/)[1]).sort(), ["412", "77"]);
});

test("blame porcelain is counted per commit, and old-side lines become ranges", () => {
  const counts = parseBlame(fs.readFileSync(path.join(FX, "blame-porcelain.txt"), "utf8"));
  assert.deepEqual(Object.fromEntries(counts), { "1111111111111111111111111111111111111111": 3, "2222222222222222222222222222222222222222": 1 });
  assert.deepEqual(lineRanges(new Set([40, 41, 42, 7, 43, 9])), [[7, 7], [9, 9], [40, 43]]);
});

test("the introducing PR is the merged PR that owns most blamed lines", () => {
  const blamed = [
    { sha: "a", lines: 1, pr: 10, merged_at: "2025-01-01T00:00:00Z" },
    { sha: "b", lines: 5, pr: 380, merged_at: "2026-07-15T00:00:00Z" },
    { sha: "c", lines: 2, pr: null, merged_at: null },
  ];
  assert.deepEqual(pickIntro(blamed), { number: 380, merged_at: "2026-07-15T00:00:00Z", sha: "b", share: 5 / 8 });
  assert.deepEqual(pickIntro([]), { number: null, merged_at: null, sha: null, share: 0 });
});

test("source.json needs the upstream, both PRs with merge dates, and the licence", () => {
  const s = {
    upstream: "https://github.com/acme/tinyq",
    intro_pr: 380, intro_merged_at: "2026-07-15T00:00:00Z",
    fix_pr: 412, fix_merged_at: "2026-08-14T09:12:00Z",
    license: "Apache-2.0",
  };
  assert.deepEqual(checkSource(s, { since: SINCE }), []);
  assert.match(checkSource({ ...s, license: "GPL-3.0" }, { since: SINCE }).join(), /licence/);
  assert.match(checkSource({ ...s, intro_merged_at: "2026-06-01T00:00:00Z" }, { since: SINCE }).join(), /intro_merged_at/);
  assert.match(checkSource({ ...s, fix_merged_at: "2026-07-10T00:00:00Z" }, { since: SINCE }).join(), /fix_merged_at .*after intro/);
  assert.match(checkSource({ ...s, fix_pr: undefined }, { since: SINCE }).join(), /fix_pr/);
});

function gitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crb-realbug-"));
  const g = (...a) => execFileSync("git", ["-C", dir, "-c", "user.email=dev@example.com", "-c", "user.name=Dev", "-c", "commit.gpgsign=false", ...a], { encoding: "utf8" }).trim();
  g("init", "-q");
  return { dir, g };
}

test("findIntro blames the fixed lines in the fix's parent and maps commits to merged PRs", async () => {
  const { dir, g } = gitRepo();
  try {
    const src = path.join(dir, "lease.go");
    fs.writeFileSync(src, "package lease\n\nfunc a() int { return 1 }\n\nfunc b() int { return 2 }\n");
    g("add", "."); g("commit", "-qm", "initial");
    const old = g("rev-parse", "HEAD");
    fs.writeFileSync(src, "package lease\n\nfunc a() int { return 1 }\n\nfunc b() int { return 3 }\n");
    g("add", "."); g("commit", "-qm", "change b");
    const intro = g("rev-parse", "HEAD");
    fs.writeFileSync(src, "package lease\n\nfunc a() int { return 1 }\n\nfunc b() int { return 2 }\n");
    fs.writeFileSync(path.join(dir, "lease_test.go"), "package lease\n");
    g("add", "."); g("commit", "-qm", "fix b");
    const fix = g("rev-parse", "HEAD");
    const prs = { [old]: [{ number: 1, merged_at: "2025-01-01T00:00:00Z" }], [intro]: [{ number: 380, merged_at: "2026-07-15T00:00:00Z" }] };
    const gh = async ([p]) => prs[p.match(/commits\/([0-9a-f]+)\/pulls/)[1]];
    const out = await findIntro({ repoDir: dir, fix, repo: "acme/tinyq", lang: "go", gh });
    assert.deepEqual(out.blamed, [{ sha: intro, lines: 1, pr: 380, merged_at: "2026-07-15T00:00:00Z" }]);
    assert.equal(out.intro.number, 380);
    assert.equal(out.intro.share, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("crb validate refuses a real bug whose source.json is missing or names a pre-cutoff introduction", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crb-realbug-task-"));
  try {
    fs.mkdirSync(path.join(dir, "repo"));
    fs.writeFileSync(path.join(dir, "repo", "crb-repo.json"), JSON.stringify({ language: "go", test_cmd: "go test ./..." }));
    fs.writeFileSync(path.join(dir, "pr.patch"), "");
    fs.writeFileSync(path.join(dir, "fix-B1.patch"), "");
    fs.mkdirSync(path.join(dir, "hidden"));
    fs.writeFileSync(path.join(dir, "hidden", "lease_test.go"), "package lease\n");
    fs.writeFileSync(path.join(dir, "task.json"), JSON.stringify({
      schema: "crb-task/v1", id: "rb-tinyq-412", repo: "rb-tinyq-412", kind: "realbug", title: "t", description: "d", pr_patch: "pr.patch",
      visible_test_cmd: null, decoys: [],
      bugs: [{ id: "B1", file: "lease.go", lines: [5, 5], category: "logic", severity: "medium", difficulty: "L2", summary: "s", trigger: "t",
        fix_patch: "fix-B1.patch", testable: true, hidden_tests: ["lease_test.go"], hidden_test_cmd: "go test ./..." }],
    }));
    let res = await validateTask(dir);
    assert.equal(res.ok, false);
    assert.match(res.results.find(r => r.oracle === "V9").detail, /cannot read source.json/);
    fs.writeFileSync(path.join(dir, "source.json"), JSON.stringify({
      upstream: "https://github.com/acme/tinyq", intro_pr: 300, intro_merged_at: "2026-05-02T10:00:00Z", fix_pr: 412, fix_merged_at: "2026-08-14T09:12:00Z", license: "Apache-2.0",
    }));
    res = await validateTask(dir);
    assert.equal(res.ok, false);
    assert.match(res.results.find(r => r.oracle === "V9").detail, /intro_merged_at is before 2026-07-01/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an unreadable repository is reported on its PR and the search goes on", async () => {
  const repos = read("repos.json");
  const files = read("files.json");
  const gh = async args => {
    const q = args.find(a => a.startsWith("q="));
    if (q) return q.includes("label:bug") ? { items: [] } : read("search-go-title.json");
    const repo = args.find(a => /^repos\/[^/]+\/[^/]+$/.test(a));
    if (repo === "repos/acme/viralcode") throw new Error("gh api repos/acme/viralcode failed: HTTP 404");
    if (repo) return repos[repo.slice("repos/".length)];
    const m = args.find(a => a.includes("/pulls/")).match(/^repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/files/);
    return [files[`${m[1]}#${m[2]}`]];
  };
  const out = await mine({ since: SINCE, langs: ["go"], minStars: 1000, pages: 1, gh });
  const vc = out.candidates.find(c => c.repo === "acme/viralcode");
  assert.equal(vc.ok, false);
  assert.match(vc.reasons[0], /gh api error: .*404/);
  assert.equal(out.candidates.find(c => c.pr === 412).ok, true);
});

test("the examination order is fixed by the seed, per language, and keeps at most two PRs of one repository", () => {
  const cands = [
    ...[1, 2, 3, 4].map(pr => ({ lang: "go", repo: "acme/tinyq", pr, ok: true })),
    { lang: "go", repo: "acme/other", pr: 5, ok: true },
    { lang: "go", repo: "acme/other", pr: 6, ok: false },
    { lang: "py", repo: "acme/pyx", pr: 7, ok: true },
  ];
  const a = selectionOrder(cands);
  const b = selectionOrder([...cands].reverse());
  assert.deepEqual(a, b);
  assert.deepEqual(Object.keys(a).sort(), ["go", "py"]);
  assert.equal(a.go.filter(c => c.repo === "acme/tinyq").length, 2);
  assert.equal(a.go.some(c => c.pr === 6), false);
  assert.ok(a.go.every((c, i) => /^[0-9a-f]{64}$/.test(c.rank) && (i === 0 || a.go[i - 1].rank < c.rank)));
});

test("repository-first mining searches the PRs of permissive repositories only and reuses their metadata", async () => {
  const title = read("search-go-title.json");
  const files = read("files.json");
  const calls = [];
  const logs = [];
  const gh = async args => {
    calls.push(args.join(" "));
    const q = args.find(a => a.startsWith("q="));
    if (args.includes("search/repositories")) {
      assert.match(q, /language:Go stars:>=1000 pushed:>=2026-07-01 archived:false size:<200000/);
      return read("search-repos-go.json");
    }
    if (q?.includes("repo:acme/brokenrepo")) throw new Error("gh api failed: HTTP 502");
    if (q) {
      const repo = q.match(/repo:(\S+)/)[1];
      assert.match(q, /is:pr is:merged merged:>=2026-07-01 fix in:title/);
      return { items: title.items.filter(it => it.repository_url.endsWith(`/${repo}`)) };
    }
    const m = args.find(a => a.includes("/pulls/")).match(/^repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/files/);
    return [files[`${m[1]}#${m[2]}`]];
  };
  const out = await mine({ since: SINCE, langs: ["go"], minStars: 1000, pages: 1, byRepo: true, gh, log: l => logs.push(l) });
  // GPL repository never searched; no separate repos/<name> lookups; a failing repository is logged and skipped
  assert.equal(calls.some(c => c.includes("repo:acme/viralcode")), false);
  assert.equal(calls.some(c => /^repos\/acme\/[a-z]+$/.test(c)), false);
  assert.ok(logs.some(l => /brokenrepo: .*502/.test(l)));
  assert.deepEqual(out.candidates.map(c => `${c.repo}#${c.pr}`).sort(), ["acme/tinyq#412", "acme/tinyq#77", "acme/tinyq#9"]);
  assert.equal(out.candidates.find(c => c.pr === 412).ok, true);
});

test("with perRepo, a repository's PRs are judged in the seeded order and files are fetched only until perRepo pass", async () => {
  const item = (number, title) => ({ repository_url: "https://api.github.com/repos/acme/tinyq", number, title, html_url: `https://github.com/acme/tinyq/pull/${number}`, labels: [], pull_request: { merged_at: "2026-08-14T09:12:00Z" }, user: { type: "User" } });
  const items = [item(412, "fix: lease retry"), item(413, "fix: pager bound"), item(414, "fix: close on error"), item(415, "fix: README typo")];
  const good = n => [{ filename: `internal/x${n}.go`, additions: 3, deletions: 1 }, { filename: `internal/x${n}_test.go`, additions: 9, deletions: 0 }];
  const fetched = [];
  const gh = async args => {
    if (args.includes("search/repositories")) return read("search-repos-go.json");
    const q = args.find(a => a.startsWith("q="));
    if (q) return { items: q.includes("repo:acme/tinyq") ? items : [] };
    const n = Number(args.find(a => a.includes("/pulls/")).match(/pulls\/(\d+)\/files/)[1]);
    fetched.push(n);
    return [n === 415 ? [{ filename: "README.md", additions: 1, deletions: 1 }] : good(n)];
  };
  const out = await mine({ since: SINCE, langs: ["go"], minStars: 1000, pages: 1, byRepo: true, perRepo: 1, gh });
  const full = await mine({ since: SINCE, langs: ["go"], minStars: 1000, pages: 1, byRepo: true, gh: async a => (a.some(x => x.includes("/pulls/")) ? [Number(a.find(x => x.includes("/pulls/")).match(/pulls\/(\d+)/)[1]) === 415 ? [{ filename: "README.md" }] : good(1)] : gh(a)) });
  const expected = selectionOrder(full.candidates, { perRepo: 1 }).go.map(c => c.pr);
  // the same candidate the order step would keep, without fetching the files of the others that rank after it
  assert.deepEqual(out.candidates.filter(c => c.ok).map(c => c.pr), expected);
  const ranked = selectionOrder(full.candidates.map(c => ({ ...c, ok: true })), { perRepo: 9 }).go.map(c => c.pr);
  assert.deepEqual(fetched, ranked.slice(0, ranked.indexOf(expected[0]) + 1));
  for (const c of out.candidates.filter(c => !c.ok && !fetched.includes(c.pr))) assert.deepEqual(c.reasons, ["not examined: the repository already has 1 candidate"]);
});
