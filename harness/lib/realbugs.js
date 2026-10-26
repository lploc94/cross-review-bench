// Real-bug control set (F9): mining candidate fix PRs with `gh api`, and finding the PR that
// introduced the fixed lines with `git blame`.

import crypto from "node:crypto";
import { run, cleanEnv, tail } from "./exec.js";
import { touchedOldLines } from "./validate.js";

/** F9: both the introducing and the fixing PR were merged on or after this day (after every cutoff). */
export const SINCE = "2026-07-01";

export const PERMISSIVE = ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "0BSD", "Unlicense"];

const NOT_SOURCE = /(^|\/)(vendor|node_modules|dist|build|third_party|testdata|fixtures?)\/|\.d\.ts$|\.pb\.go$|_generated\.|\.gen\.|\.min\.js$/;

export const LANGS = {
  ts: { github: "TypeScript", source: /\.[cm]?[jt]sx?$/, test: /(^|\/)(__tests__|tests?)\/|\.(test|spec)\.[cm]?[jt]sx?$/ },
  py: { github: "Python", source: /\.py$/, test: /(^|\/)tests?\/|(^|\/)test_[^/]*\.py$|_test\.py$|(^|\/)conftest\.py$/ },
  go: { github: "Go", source: /\.go$/, test: /_test\.go$/ },
  java: { github: "Java", source: /\.java$/, test: /(^|\/)src\/test\// },
};

const BOT_TITLE = /^(build|chore|fix)\(deps(-dev)?\)|\bbump\b|\bdependabot\b|\brenovate\b/i;
const FIX_TITLE = /\bfix(es|ed|ing)?\b/i;
const BUG_LABEL = /bug|fix/i;

const isTest = (lang, f) => LANGS[lang].test.test(f);
const isSource = (lang, f) => LANGS[lang].source.test(f) && !isTest(lang, f) && !NOT_SOURCE.test(f);
const before = (iso, since) => Date.parse(iso) < Date.parse(`${since}T00:00:00Z`);

/**
 * Whether a fix PR is a candidate, with every reason it is not. `c.files` may be null (not fetched
 * yet: the file rules are skipped) and `c.intro` is present once the introducing PR is known.
 */
export function judgeCandidate(c, { since, minStars }) {
  const reasons = [];
  const { pr, repo } = c;
  if (!pr.merged_at) reasons.push("not merged");
  else if (before(pr.merged_at, since)) reasons.push(`fix merged before ${since}`);
  if (pr.author_type === "Bot" || BOT_TITLE.test(pr.title) || pr.labels.includes("dependencies")) reasons.push("bot or dependency update");
  else if (!FIX_TITLE.test(pr.title) && !pr.labels.some(l => BUG_LABEL.test(l))) reasons.push("no fix in the title or a bug label");
  if (repo.stars < minStars) reasons.push(`fewer than ${minStars} stars`);
  if (!repo.license || repo.license === "NOASSERTION") reasons.push("no licence");
  else if (!PERMISSIVE.includes(repo.license)) reasons.push(`licence ${repo.license} is not permissive`);
  if (repo.archived) reasons.push("archived repository");
  if (c.files) {
    if (!c.files.some(f => isTest(c.lang, f.filename))) reasons.push("changes no test");
    if (!c.files.some(f => isSource(c.lang, f.filename))) reasons.push("changes no source file");
  }
  if (c.intro) {
    if (!c.intro.number || !c.intro.merged_at) reasons.push("introducing change has no merged PR");
    else if (before(c.intro.merged_at, since)) reasons.push(`introducing PR #${c.intro.number} merged before ${since}`);
    else if (c.intro.number === pr.number) reasons.push("introducing PR is the fix itself");
  }
  return { ok: reasons.length === 0, reasons };
}

/** GitHub search queries for one language: "fix" in the title, and a bug label. */
export function searchQueries(lang, since) {
  const base = `is:pr is:merged merged:>=${since} language:${LANGS[lang].github} -author:app/dependabot -author:app/renovate`;
  return [`${base} fix in:title`, `${base} label:bug`];
}

// GitHub's secondary rate limits punish bursts: calls are spaced (search much more than the rest),
// and a rate-limit answer waits minutes before the next try.
const SPACING_MS = { search: 3000, core: 800 };
const lastCall = { search: 0, core: 0 };
const sleep = ms => new Promise(res => setTimeout(res, ms));

/** `gh api <args>` as parsed JSON; transient failures are retried, rate limits after a long wait. */
export async function ghApi(args, { attempts = 6, waitMs = 5000, limitWaitMs = 90_000 } = {}) {
  const kind = args.some(a => a.startsWith("search/")) ? "search" : "core";
  let r;
  for (let i = 0; i < attempts; i++) {
    const due = lastCall[kind] + SPACING_MS[kind] - Date.now();
    if (due > 0) await sleep(due);
    lastCall[kind] = Date.now();
    r = await run("gh", ["api", ...args], { env: cleanEnv(), timeoutMs: 120_000 });
    if (r.code === 0) return JSON.parse(r.stdout);
    const out = `${r.stdout}\n${r.stderr}`;
    if (/HTTP 404|HTTP 422/.test(out)) break;
    await sleep(/rate limit/i.test(out) ? limitWaitMs * (i + 1) : waitMs * (i + 1));
  }
  throw new Error(`gh api ${args.join(" ")} failed: ${tail(r, 4)}`);
}

/** GitHub repository search for one language: active since the cutoff, popular enough, not huge. */
export function repoQuery(lang, since, minStars, maxSizeKb) {
  return `language:${LANGS[lang].github} stars:>=${minStars} pushed:>=${since} archived:false size:<${maxSizeKb}`;
}

const repoRow = r => ({ full_name: r.full_name, stars: r.stargazers_count, license: r.license?.spdx_id ?? null, archived: Boolean(r.archived), size_kb: r.size });

/**
 * Candidate fix PRs merged since `since` in the given languages. Cheap rules (date, author, title,
 * stars, licence) run before a PR's files are fetched; every PR seen is returned with its verdict.
 * By default PRs come from a GitHub-wide search; `byRepo` first lists the language's repositories
 * (stars, recent push, size under `maxSizeKb`, permissive licence) and searches each one's PRs, which
 * finds far more PRs in repositories that can pass the rules. With `perRepo`, PRs are judged in the
 * seeded examination order and a repository's later PRs are not examined once `perRepo` of them pass:
 * the order step would drop them anyway, and their file lists are most of the API calls.
 */
export async function mine({ since, langs, minStars = 1000, pages = 3, byRepo = false, maxSizeKb = 200_000, perRepo = Infinity, gh = ghApi, log = () => {} }) {
  const repoInfo = new Map();
  const candidates = [];
  const collect = (seen, items) => {
    for (const it of items ?? []) {
      const repo = it.repository_url.replace(/^https:\/\/api\.github\.com\/repos\//, "");
      const key = `${repo}#${it.number}`;
      const labels = (it.labels ?? []).map(l => l.name);
      const prev = seen.get(key);
      if (prev) { prev.labels = [...new Set([...prev.labels, ...labels])]; continue; }
      seen.set(key, { repo, number: it.number, title: it.title, url: it.html_url, labels, merged_at: it.pull_request?.merged_at ?? null, author_type: it.user?.type ?? null });
    }
  };
  const search = (endpoint, q, page) => gh(["-X", "GET", endpoint, "-f", `q=${q}`, "-f", "per_page=100", "-f", `page=${page}`]);
  for (const lang of langs) {
    if (!LANGS[lang]) throw new Error(`unknown language ${lang} (one of ${Object.keys(LANGS).join(", ")})`);
    const seen = new Map();
    if (byRepo) {
      const repos = [];
      for (let page = 1; page <= pages; page++) {
        const res = await search("search/repositories", repoQuery(lang, since, minStars, maxSizeKb), page);
        for (const r of res.items ?? []) {
          repoInfo.set(r.full_name, repoRow(r));
          if (PERMISSIVE.includes(repoRow(r).license)) repos.push(r.full_name);
        }
        if ((res.items ?? []).length < 100) break;
      }
      log(`${lang}: ${repos.length} repositories with a permissive licence`);
      for (const [i, repo] of repos.entries()) {
        try {
          collect(seen, (await search("search/issues", `repo:${repo} is:pr is:merged merged:>=${since} fix in:title`, 1)).items);
        } catch (e) {
          log(`${lang}: ${repo}: ${e.message.split("\n")[0]}`);
        }
        if ((i + 1) % 20 === 0) log(`${lang}: searched ${i + 1}/${repos.length} repositories, ${seen.size} PRs`);
      }
    } else {
      for (const q of searchQueries(lang, since)) {
        for (let page = 1; page <= pages; page++) {
          const res = await search("search/issues", q, page);
          collect(seen, res.items);
          if ((res.items ?? []).length < 100) break;
        }
      }
    }
    log(`${lang}: ${seen.size} PRs to judge`);
    const passed = new Map();
    let judged = 0;
    for (const pr of [...seen.values()].sort((a, b) => selectionRank(a.repo, a.number).localeCompare(selectionRank(b.repo, b.number)))) {
      const c = { lang, repo: null, pr, files: null };
      let verdict;
      try {
        if (!repoInfo.has(pr.repo)) {
          const r = await gh([`repos/${pr.repo}`]);
          repoInfo.set(pr.repo, repoRow({ ...r, full_name: pr.repo }));
        }
        c.repo = repoInfo.get(pr.repo);
        if ((passed.get(pr.repo) ?? 0) >= perRepo) throw Object.assign(new Error(`not examined: the repository already has ${perRepo} candidate${perRepo === 1 ? "" : "s"}`), { skip: true });
        verdict = judgeCandidate(c, { since, minStars });
        if (verdict.ok) {
          c.files = (await gh(["--paginate", "--slurp", `repos/${pr.repo}/pulls/${pr.number}/files?per_page=100`])).flat();
          verdict = judgeCandidate(c, { since, minStars });
        }
      } catch (e) {
        // one unreadable repository or PR (deleted, private now, network) does not stop the search
        verdict = { ok: false, reasons: [e.skip ? e.message : `gh api error: ${e.message.split("\n")[0]}`] };
        c.repo ??= { stars: null, license: null, size_kb: null };
      }
      candidates.push({
        lang, repo: pr.repo, pr: pr.number, url: pr.url, title: pr.title, labels: pr.labels, merged_at: pr.merged_at,
        stars: c.repo.stars, license: c.repo.license, size_kb: c.repo.size_kb,
        source_files: c.files ? c.files.map(f => f.filename).filter(f => isSource(lang, f)) : null,
        test_files: c.files ? c.files.map(f => f.filename).filter(f => isTest(lang, f)) : null,
        ok: verdict.ok, reasons: verdict.reasons,
      });
      if (verdict.ok) passed.set(pr.repo, (passed.get(pr.repo) ?? 0) + 1);
      if (++judged % 200 === 0) log(`${lang}: judged ${judged}/${seen.size} PRs, ${[...passed.values()].reduce((a, b) => a + b, 0)} pass`);
    }
  }
  return { since, langs, min_stars: minStars, candidates };
}

/** Seed of the selection order (F9): candidates are examined in this order, not picked by taste. */
export const SELECTION_SEED = "crb-realbugs-2026-10";

/** A PR's place in the examination order: sha256(seed + "owner/repo#pr"). */
export function selectionRank(repo, pr, seed = SELECTION_SEED) {
  return crypto.createHash("sha256").update(`${seed}${repo}#${pr}`).digest("hex");
}

/**
 * The passing candidates of a `mine` result in the fixed examination order: per language, by
 * sha256(seed + "owner/repo#pr"). At most `perRepo` candidates of one upstream repository are kept.
 */
export function selectionOrder(candidates, { seed = SELECTION_SEED, perRepo = 2 } = {}) {
  const rank = c => selectionRank(c.repo, c.pr, seed);
  const out = {};
  for (const c of candidates.filter(c => c.ok).map(c => ({ ...c, rank: rank(c) })).sort((a, b) => a.rank.localeCompare(b.rank))) {
    const list = (out[c.lang] ??= []);
    if (list.filter(x => x.repo === c.repo).length < perRepo) list.push(c);
  }
  return out;
}

/** `git blame --porcelain` output → Map of commit → number of blamed lines. */
export function parseBlame(text) {
  const counts = new Map();
  for (const line of text.split("\n")) {
    const m = line.match(/^([0-9a-f]{40}) \d+ \d+(?: (\d+))?$/);
    if (m) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  }
  return counts;
}

/** A set of line numbers → sorted [start, end] ranges of consecutive lines. */
export function lineRanges(set) {
  const out = [];
  for (const n of [...set].sort((a, b) => a - b)) {
    const last = out.at(-1);
    if (last && n === last[1] + 1) last[1] = n; else out.push([n, n]);
  }
  return out;
}

/** The merged PR owning most blamed lines, and its share of all blamed lines. */
export function pickIntro(blamed) {
  const total = blamed.reduce((s, b) => s + b.lines, 0);
  const byPr = new Map();
  for (const b of blamed.filter(b => b.pr && b.merged_at)) {
    const e = byPr.get(b.pr) ?? { number: b.pr, merged_at: b.merged_at, sha: b.sha, lines: 0 };
    e.lines += b.lines;
    byPr.set(b.pr, e);
  }
  const top = [...byPr.values()].sort((a, b) => b.lines - a.lines)[0];
  if (!top) return { number: null, merged_at: null, sha: null, share: 0 };
  return { number: top.number, merged_at: top.merged_at, sha: top.sha, share: top.lines / total };
}

async function git(repoDir, args) {
  const r = await run("git", ["-C", repoDir, ...args], { env: cleanEnv(), timeoutMs: 300_000 });
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${tail(r, 4)}`);
  return r.stdout;
}

/**
 * Blame the lines a fix commit removes or inserts at (source files only, in the fix's parent) and
 * map each blamed commit to its merged PR. `fix` is the fix PR's squash or merge commit in a local
 * clone; for a merge commit the first parent is the pre-fix state.
 */
export async function findIntro({ repoDir, fix, repo, lang, gh = ghApi }) {
  const diff = await git(repoDir, ["diff", "-U0", "--no-color", "--no-ext-diff", `${fix}^1`, fix]);
  const blamed = new Map();
  for (const [file, lines] of touchedOldLines(diff)) {
    if (!isSource(lang, file)) continue;
    const exists = await run("git", ["-C", repoDir, "cat-file", "-e", `${fix}^1:${file}`], { env: cleanEnv() });
    if (exists.code !== 0) continue;
    const length = (await git(repoDir, ["show", `${fix}^1:${file}`])).split("\n").length - 1;
    for (const [a, b] of lineRanges(lines)) {
      const lo = Math.min(Math.max(a, 1), length);
      const hi = Math.min(b, length);
      if (lo < 1 || hi < lo) continue;
      const out = await git(repoDir, ["blame", "--porcelain", "-L", `${lo},${hi}`, `${fix}^1`, "--", file]);
      for (const [sha, n] of parseBlame(out)) blamed.set(sha, (blamed.get(sha) ?? 0) + n);
    }
  }
  const rows = [];
  for (const [sha, lines] of blamed) {
    const prs = await gh([`repos/${repo}/commits/${sha}/pulls`]);
    const merged = (prs ?? []).find(p => p.merged_at);
    rows.push({ sha, lines, pr: merged?.number ?? null, merged_at: merged?.merged_at ?? null });
  }
  rows.sort((a, b) => b.lines - a.lines);
  return { fix, blamed: rows, intro: pickIntro(rows) };
}

/** Problems of a real bug's source.json; [] when valid. */
export function checkSource(s, { since }) {
  const p = [];
  if (typeof s?.upstream !== "string" || !/^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(s.upstream)) p.push("upstream must be https://github.com/<owner>/<repo>");
  for (const k of ["intro_pr", "fix_pr"]) if (!Number.isInteger(s?.[k]) || s[k] < 1) p.push(`${k} must be a PR number`);
  for (const k of ["intro_merged_at", "fix_merged_at"]) if (typeof s?.[k] !== "string" || Number.isNaN(Date.parse(s[k]))) p.push(`${k} must be an ISO date`);
  if (!p.length) {
    if (before(s.intro_merged_at, since)) p.push(`intro_merged_at is before ${since}`);
    if (Date.parse(s.fix_merged_at) <= Date.parse(s.intro_merged_at)) p.push("fix_merged_at must be after intro_merged_at");
  }
  if (!PERMISSIVE.includes(s?.license)) p.push(`licence must be one of ${PERMISSIVE.join(", ")}`);
  return p;
}
