// Leakage audit (I3): read a run's reviewer event logs and flag any access outside the run.
//
// Tool inputs are taken from each reviewer's event format (Codex `command_execution`, `file_change`,
// `mcp_tool_call`, `web_search`; Claude Code `tool_use` inputs; agy `tool_info.parameters`). Paths in
// them, and in the commands they run, are resolved: `~` and `$HOME` are the run home, relative paths
// start at the command's cwd (following `cd`), `/tmp` ≡ `/private/tmp`, symlinks are followed where
// they exist, and the run home's Library/Keychains link is the real Keychain.
//
// Flagged: the real home outside its read-only toolchain folders, any other /Users or /Volumes path,
// other runs' dirs under the run root (or a glob over them), a glob among a shared temp root's entries
// or a listing of the root (/tmp, /var/folders down to a user's T dir: every run's scratch sits there
// side by side; ls, find and the like list a path or, given none, their cwd; a tool lists its path), the
// Keychain, the `security` and `hdiutil` commands, and (real bugs) the upstream repository where a tool
// reaches it: a web tool naming it, a URL to it, or a fetch command naming it (not an import path in code). `$TMPDIR` is the run's (ctx.tmpdir, else <runDir>/tmp). Everything else — this run, a
// named file in /tmp or /var/folders, system and Homebrew paths, strings that are not host paths — passes.

import fs from "node:fs";
import path from "node:path";

const HOME_TOOLCHAIN = [".local/bin", ".local/share/uv/python", ".local/share/claude", ".crbench/cache", ".crbench/cross-review-v10.5.1"];
const BANNED_COMMANDS = new Set(["security", "hdiutil"]);
// run dirs under the run root are named with 8 hex digits (scheduler.js executeRun)
const RUN_DIR = /^[0-9a-f]{8}$/;
const SHELLS = /^(?:ba|z|da|k)?sh$/;
const GLOB = /[*?[\]{}]/;
// commands that list or search the directories they are given (path operands), or their cwd
const LISTS = new Set(["ls", "find", "tree", "du", "fd", "rg", "grep", "ag", "eza", "exa"]);
// options whose value is the next word (a pattern, a glob, a number), per search command
const VALUE_OPTS = {
  rg: new Set(["-e", "--regexp", "-f", "--file", "-g", "--glob", "--iglob", "-t", "--type", "-T", "--type-not", "--type-add", "-m", "--max-count", "-A", "-B", "-C", "--after-context", "--before-context", "--context", "-d", "--max-depth", "-M", "--max-columns", "-j", "--threads", "-r", "--replace", "-E", "--encoding", "--sort", "--sortr", "--pre", "--ignore-file", "--max-filesize", "--color", "--colors", "--path-separator"]),
  grep: new Set(["-e", "--regexp", "-f", "--file", "-m", "--max-count", "-A", "-B", "-C", "--context", "-d", "--directories", "-D", "--devices", "--include", "--exclude", "--exclude-dir", "--color", "--colour", "--label"]),
  ag: new Set(["-G", "--file-search-regex", "--ignore", "-m", "--max-count", "-A", "-B", "-C", "--context", "--depth", "-g", "--pager"]),
  fd: new Set(["-e", "--extension", "-t", "--type", "-d", "--max-depth", "--min-depth", "--exact-depth", "-E", "--exclude", "-S", "--size", "--changed-within", "--changed-before", "-o", "--owner", "-j", "--threads", "-c", "--color", "--base-directory", "--search-path", "--max-results", "--ignore-file"]),
};
const PATTERN_OPTS = new Set(["-e", "--regexp", "-f", "--file"]);
// a search for instruction files only (Codex looks for them in every dir above the workspace) names
// nothing of another run: rg --files whose every positive glob is one, or find whose every test is a name test of one
const INSTRUCTION_FILE = /^(?:AGENTS|CLAUDE)(?:\.override)?\.md$/;
const RG_EXEMPT_FLAGS = new Set(["--files", "--hidden", "--no-ignore", "--no-ignore-vcs", "-u", "-uu", "-uuu", "--no-messages", "-L", "--follow", "-0", "--null"]);
const REDIRECT_ALONE = /^(?:\d*|&)(?:>>?|<)$/;
const REDIRECT = /^(?:\d*|&)(?:>>?|<)/;
// web search and fetch tools (Claude Code WebSearch/WebFetch; agy search_web, read_url_content and the like)
const WEB_TOOL = /web|url|browser/i;

const HEREDOC = /(?<!<)<<(?!<)-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g;
const NAIVE_SPLIT = /&&|\|\||[;|\n&]|\$\(|`|(?<!\\)[()]/;

/**
 * A command line cut into simple commands at `&&`, `||`, `;`, `|`, `&`, newlines, subshell parens
 * and command substitutions, outside quotes (a quoted script stays whole), but inside `"$(…)"`, which
 * the shell runs. A heredoc's body is cut line by line, so a stray quote in it ends with its line.
 */
function splitCommands(text) {
  const segs = [];
  let buf = [];
  const lines = text.split("\n");
  for (let n = 0; n < lines.length; n++) {
    buf.push(lines[n]);
    const delims = [...lines[n].matchAll(HEREDOC)].map(m => m[2]);
    if (!delims.length) continue;
    segs.push(...quoteSplit(buf.join("\n")));
    buf = [];
    for (const delim of delims) {
      while (n + 1 < lines.length && lines[n + 1].trim() !== delim) segs.push(...lines[++n].split(NAIVE_SPLIT));
      n++;
    }
  }
  segs.push(...quoteSplit(buf.join("\n")));
  return segs;
}

function quoteSplit(text) {
  const out = [];
  scanCommands(text, 0, null, out);
  return out;
}

// what stands in a command for a substitution's output: no path, no glob
const SUBST = "$__subst";

/**
 * Cut `text` from `k` into `out` until `closer` (the `)` or backtick ending a substitution) or the end;
 * returns the index after the closer. A substitution's body is cut on its own (it runs first) and
 * leaves SUBST in the command around it; a comment runs to the end of its line.
 */
function scanCommands(text, k, closer, out) {
  let cur = "";
  let q = null;
  let depth = 0; // subshell parens open inside this level
  const cut = () => { out.push(cur); cur = ""; };
  for (; k < text.length; k++) {
    const c = text[k];
    if (q === "'") { cur += c; if (c === "'") q = null; continue; }
    if (c === "\\" && k + 1 < text.length) { cur += c + text[++k]; continue; }
    if ((c === "$" && text[k + 1] === "(") || c === "`") {
      if (c === "`" && closer === "`" && q === null) { cut(); return k + 1; }
      k = scanCommands(text, c === "`" ? k + 1 : k + 2, c === "`" ? "`" : ")", out) - 1;
      cur += SUBST;
      continue;
    }
    if (q === '"') { cur += c; if (c === '"') q = null; continue; }
    if (c === "'" || c === '"') { q = c; cur += c; continue; }
    if (c === "#" && (k === 0 || /[\s;&|()]/.test(text[k - 1]))) {
      while (k + 1 < text.length && text[k + 1] !== "\n") k++;
      continue;
    }
    if (c === ")") {
      if (depth > 0) { depth--; cut(); continue; }
      if (closer === ")") { cut(); return k + 1; }
      cut();
      continue;
    }
    if (c === "(") { depth++; cut(); continue; }
    // `2>&1`, `>&2` and `&>` are redirections, not a background `&`
    if (c === "&" && (/[<>]/.test(text[k - 1] ?? "") || text[k + 1] === ">")) { cur += c; continue; }
    if ((c === "&" || c === "|") && text[k + 1] === c) { cut(); k++; continue; }
    if (";|\n&".includes(c)) { cut(); continue; }
    cur += c;
  }
  cut();
  return k;
}

/** Shell words of one command, quotes removed; `glob`: a glob character outside quotes (the shell expands it). */
function shellWords(seg) {
  const out = [];
  let cur = null;
  let q = null;
  for (let k = 0; k < seg.length; k++) {
    const c = seg[k];
    if (q) {
      if (c === q) q = null;
      else if (q === '"' && c === "\\" && k + 1 < seg.length) cur.text += seg[++k];
      else cur.text += c;
      continue;
    }
    if (/\s/.test(c)) { if (cur) out.push(cur); cur = null; continue; }
    cur ??= { text: "", glob: false };
    if (c === "'" || c === '"') q = c;
    else if (c === "\\" && k + 1 < seg.length) cur.text += seg[++k];
    else { if (GLOB.test(c)) cur.glob = true; cur.text += c; }
  }
  if (cur) out.push(cur);
  return out;
}

/** An option word of a search command: { value: next word is its value, given: its attached value }. */
function option(cmd, w) {
  const opts = VALUE_OPTS[cmd] ?? new Set();
  if (w.startsWith("--")) {
    const eq = w.indexOf("=");
    return eq > 0 ? { name: w.slice(0, eq), value: false, given: w.slice(eq + 1) } : { name: w, value: opts.has(w) };
  }
  for (let k = 1; k < w.length; k++) {
    if (opts.has(`-${w[k]}`)) return k === w.length - 1 ? { name: `-${w[k]}`, value: true, cluster: w } : { name: `-${w[k]}`, value: false, given: w.slice(k + 1), cluster: w };
  }
  return { name: w, value: false, cluster: w };
}

// find tests that take one argument and look only at a file's name, place or metadata
const FIND_NAME_TESTS = new Set(["-name", "-iname", "-path", "-ipath", "-type", "-maxdepth", "-mindepth", "-size", "-mtime", "-mmin", "-atime", "-amin", "-ctime", "-cmin", "-newer", "-perm", "-user", "-group", "-links", "-inum"]);

// a depth limit of 0 or 1 keeps a listing to the entries of the dirs it is given
const SHALLOW = /^(?:-maxdepth|-d|--max-depth|-L|--level|--depth)(?:=|$)/;
const shallowDepth = args => args.some((a, k) => SHALLOW.test(a) && /^[01]$/.test(a.includes("=") ? a.slice(a.indexOf("=") + 1) : args[k + 1] ?? ""));

/**
 * Which words of a listing or search command are directories it lists (path operands), whether it
 * lists its cwd for want of one, whether it is an instruction-file search, and whether it descends
 * below the dirs it lists (`deep`). `args`: the words after the command name, redirections removed.
 */
function listing(cmd, args) {
  return { ...listingOperands(cmd, args), deep: descends(cmd, args) };
}

function descends(cmd, args) {
  const flags = args.filter(a => /^-[A-Za-z]/.test(a) && !a.startsWith("--"));
  if (cmd === "ls") return flags.some(a => a.includes("R")) || args.includes("--recursive");
  if (cmd === "eza" || cmd === "exa") return flags.some(a => /[RT]/.test(a)) || args.includes("--recurse") || args.includes("--tree");
  // du -s prints one total per operand
  if (cmd === "du") return !flags.some(a => a.includes("s")) && !args.includes("--summarize") && !shallowDepth(args);
  if (cmd === "grep") return flags.some(a => /[rR]/.test(a)) || args.includes("--recursive") || args.includes("--directories=recurse");
  // find, tree, rg, fd, ag descend unless held to depth 1
  return !shallowDepth(args);
}

function listingOperands(cmd, args) {
  const operands = new Set();
  if (["ls", "tree", "du", "eza", "exa"].includes(cmd)) {
    let opts = true;
    args.forEach((a, k) => { if (opts && a === "--") opts = false; else if (!opts || !a.startsWith("-")) operands.add(k); });
    return { operands, cwd: operands.size === 0, exempt: false };
  }
  if (cmd === "find") {
    let k = 0;
    // leading options before the paths: -H -L -P (and BSD -E -X -d -s -x), -f <path>, GNU -D <opts> and -O<n>
    for (;;) {
      if (/^-[HLPEXdsx]+$/.test(args[k] ?? "") || /^-O\d$/.test(args[k] ?? "")) k++;
      else if (args[k] === "-f") { operands.add(k + 1); k += 2; }
      else if (args[k] === "-D") k += 2;
      else break;
    }
    while (k < args.length && !/^(?:-|!|\(|\\\()/.test(args[k])) operands.add(k++);
    const expr = args.slice(k);
    const or = expr.some(a => a === "-o" || a === "-or");
    const names = [];
    let exempt = true;
    for (let j = 0; j < expr.length; j++) {
      const a = expr[j];
      if (a === "-name" || a === "-iname") names.push(expr[++j] ?? "");
      else if (a === "-maxdepth" || a === "-mindepth" || (a === "-type" && !or)) j++;
      else if (!["-o", "-or", "(", ")", "\\(", "\\)", "-print", "-print0"].includes(a)) exempt = false;
    }
    // a search by name (`find / -name pytest`, a tool hunt) prints only the paths whose name matches;
    // tests on a file's metadata (`-size +100k`, `-mtime -1`) narrow it without reading contents
    let byName = expr.some(a => ["-name", "-iname", "-path", "-ipath"].includes(a));
    for (let j = 0; j < expr.length; j++) {
      const a = expr[j];
      if (FIND_NAME_TESTS.has(a)) j++;
      else if (!["-o", "-or", "-a", "-and", "-not", "!", "-prune", "-empty", "(", ")", "\\(", "\\)", "-print", "-print0", "-quit"].includes(a)) byName = false;
    }
    return { operands, cwd: operands.size === 0, exempt: exempt && names.length > 0 && names.every(n => INSTRUCTION_FILE.test(n)), byName };
  }
  // rg, grep, ag, fd: the first positional is the pattern (unless -e/-f give it, or rg --files), the rest are paths
  const positional = [];
  const globs = [];
  let patternGiven = false;
  let recursive = false;
  let exempt = true;
  let opts = true;
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (!opts || a === "-" || !a.startsWith("-")) { positional.push(k); continue; }
    if (a === "--") { opts = false; continue; }
    const o = option(cmd, a);
    if (PATTERN_OPTS.has(o.name)) patternGiven = true;
    if (cmd === "rg" && a === "--files") patternGiven = true;
    // fd's search roots: --search-path, and --base-directory, which it searches for want of a path
    if (cmd === "fd" && (o.name === "--search-path" || o.name === "--base-directory")) operands.add(o.value ? k + 1 : k);
    if (cmd === "grep" && (/^-[A-Za-z]*[rR]/.test(o.cluster ?? "") || a === "--recursive" || o.name === "-d" || o.name === "--directories")) recursive = true;
    if (o.name === "-g" || o.name === "--glob" || o.name === "--iglob") globs.push(o.value ? args[k + 1] ?? "" : o.given ?? "");
    else if (!RG_EXEMPT_FLAGS.has(a)) exempt = false;
    if (o.value) k++;
  }
  const paths = positional.slice(patternGiven ? 0 : 1);
  for (const k of paths) operands.add(k);
  // quotes a `zsh -lc "…"'!'"…"` concatenation leaves in a value are not part of the glob
  const wanted = globs.map(g => g.replace(/['"\\]/g, "")).filter(g => !g.startsWith("!"));
  exempt = cmd === "rg" && args.includes("--files") && exempt && wanted.length > 0 && wanted.every(g => INSTRUCTION_FILE.test(g));
  // a search by name prints paths, not contents: `rg --files` held to wanted globs, or fd without --exec
  const byName = cmd === "rg" ? args.includes("--files") && wanted.length > 0
    : cmd === "fd" ? !args.some(a => /^(?:-x|-X|--exec|--exec-batch)(?:=|$)/.test(a)) : false;
  return { operands, cwd: operands.size === 0 && (cmd !== "grep" || recursive), exempt, byName };
}

const TMPDIR_VAR = /\$\{TMPDIR(?::?[-=?+][^}]*)?\}|\$TMPDIR(?![A-Za-z0-9_])/g;
const PREFIX_WORDS = new Set(["sudo", "env", "command", "exec", "nohup", "time", "nice", "builtin", "then", "do", "else", "!", "{"]);

const under = (p, dir) => p === dir || p.startsWith(dir.endsWith("/") ? dir : `${dir}/`);

function unprivate(p) {
  for (const d of ["/tmp", "/var", "/etc"]) if (p === `/private${d}` || p.startsWith(`/private${d}/`)) return p.slice("/private".length);
  return p;
}

/** Follow symlinks component by component where they exist; keep the rest lexical. */
function resolveLinks(abs, hops = 0) {
  const parts = abs.split("/").filter(Boolean);
  let cur = "/";
  for (let i = 0; i < parts.length; i++) {
    const next = path.join(cur, parts[i]);
    let st;
    try { st = fs.lstatSync(next); } catch { return path.join(next, ...parts.slice(i + 1)); }
    if (st.isSymbolicLink() && hops < 40) {
      const target = path.resolve(cur, fs.readlinkSync(next));
      return resolveLinks(path.join(target, ...parts.slice(i + 1)), hops + 1);
    }
    cur = next;
  }
  return cur;
}

export function canonical(p) {
  return unprivate(resolveLinks(unprivate(path.resolve(p))));
}

/**
 * A token as a host path, or null when it is not one. Absolute paths, `~`, `~user`, `$HOME` and
 * relative paths with a `..` segment count; other relative paths stay inside cwd, unless `anyRelative`
 * (cwd is outside the workspace), when every word that is not a flag counts.
 */
function tokenPath(tok, cwd, runHome, anyRelative = false) {
  let t = tok.replace(/^@/, "").replace(/^file:\/\//i, "");
  const flag = t.match(/^-{1,2}[A-Za-z][\w-]*(\/.*)$/);
  if (flag) t = flag[1];
  if (t === "~" || t.startsWith("~/")) return path.join(runHome, t.slice(1));
  const user = t.match(/^~([A-Za-z0-9._-]+)(\/.*)?$/);
  if (user) return path.join("/Users", user[1], user[2] ?? "");
  if (t === "$HOME" || t.startsWith("$HOME/")) return path.join(runHome, t.slice(5));
  if (t.startsWith("/")) return t;
  if (t.split("/").includes("..")) return path.resolve(cwd, t);
  if (anyRelative && t && !t.startsWith("-") && !t.startsWith("$")) return path.resolve(cwd, t);
  return null;
}

/** Split a token on `=`, `,` and `:` (not inside a URL scheme). */
function subTokens(word) {
  const out = [];
  for (const piece of word.split(/[=,]/)) {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(piece)) out.push(piece);
    else out.push(...piece.split(":"));
  }
  return out.filter(Boolean);
}

function unwrapShell(cmd) {
  let s = cmd.trim();
  for (let i = 0; i < 3; i++) {
    const m = s.match(/^(?:\/usr)?(?:\/bin\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1\s*$/);
    if (!m) break;
    s = m[1] === '"' ? m[2].replace(/\\(["\\$`])/g, "$1") : m[2];
  }
  return s;
}

/**
 * Paths a command touches (resolved), cd targets included, and banned commands it runs. Outside
 * the workspace `wsDir` (canonical), every relative word counts as a path.
 */
export function analyzeCommand(cmd, cwd, runHome, wsDir, tmpDir = path.join(path.dirname(runHome), "tmp")) {
  const paths = [];
  const banned = [];
  const text = unwrapShell(String(cmd)).replace(/\$\{HOME\}/g, "$HOME").replace(TMPDIR_VAR, tmpDir);
  let dir = cwd;
  for (const seg of splitCommands(text)) {
    const all = shellWords(seg);
    // a redirection's target is a path the command touches, but not an argument: `ls > out.txt` lists its cwd
    const words = [];
    for (let k = 0; k < all.length; k++) {
      const t = all[k].text;
      if (REDIRECT_ALONE.test(t)) { if (all[k + 1]) words.push({ ...all[++k], redirect: true }); continue; }
      const m = t.match(REDIRECT);
      if (m) { const target = t.slice(m[0].length); if (!/^&?\d*-?$/.test(target)) words.push({ ...all[k], text: target, redirect: true }); continue; }
      words.push(all[k]);
    }
    // the command and its arguments: every word but redirection targets (`2>/dev/null ls /tmp` runs ls)
    const cw = words.filter(w => !w.redirect);
    let i = 0;
    for (;;) {
      if (i < cw.length && (PREFIX_WORDS.has(cw[i].text) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(cw[i].text))) i++;
      else break;
    }
    const anyRelative = !under(canonical(dir), wsDir);
    const collect = (w, listed, deep = false, byName = false) => {
      for (const tok of subTokens(w.text)) {
        const p = tokenPath(tok, dir, runHome, anyRelative);
        if (!p) continue;
        // a word that is a path only because cwd is outside the workspace may be code text (python -c,
        // a heredoc): its * and [ are a glob when a listing takes it or it reads like a path
        const relOnly = !tokenPath(tok, dir, runHome);
        paths.push({ value: tok, path: p, lists: listed, globs: w.glob && (!relOnly || listed || tok.includes("/")), deep: listed && deep, byName: listed && byName });
      }
    };
    // an inner `bash -c "…"` (or one unwrapShell could not peel): the script is a command line of its
    // own; the wrapper's other words (assignments, redirections) are paths of the wrapper
    if (SHELLS.test(path.basename(cw[i]?.text ?? "")) && /^-[A-Za-z]*c[A-Za-z]*$/.test(cw[i + 1]?.text ?? "")) {
      const script = new Set(cw.slice(i + 2));
      for (const w of words) if (!script.has(w)) collect(w, false);
      const inner = analyzeCommand(cw.slice(i + 2).map(w => w.text).join(" "), dir, runHome, wsDir, tmpDir);
      paths.push(...inner.paths);
      banned.push(...inner.banned);
      continue;
    }
    const name = cw[i] ? path.basename(cw[i].text) : null;
    if (name && BANNED_COMMANDS.has(name)) banned.push(name);
    const args = cw.slice(i + 1);
    const list = LISTS.has(name) ? listing(name, args.map(w => w.text)) : null;
    for (const w of words) collect(w, Boolean(list && !list.exempt && list.operands.has(args.indexOf(w))), list?.deep, list?.byName);
    if (list && !list.exempt && list.cwd) paths.push({ value: cw[i].text, path: dir, lists: true, globs: false, deep: list.deep, byName: list.byName });
    if (name === "cd") dir = tokenPath(cw[i + 1]?.text ?? "~", dir, runHome) ?? path.resolve(dir, cw[i + 1].text);
  }
  return { paths, banned };
}

// commands that fetch what they name over the network: any use, or (git, go) these subcommands
const FETCHERS = new Set(["curl", "wget", "gh", "hub", "http", "https", "xh", "aria2c", "lynx", "w3m"]);
const FETCH_SUBCOMMANDS = { git: ["clone", "fetch", "ls-remote", "pull", "archive", "submodule", "remote"], go: ["get", "install", "mod"] };
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether a tool input reaches the upstream repository `frag` (`github.com/owner/repo`, lower case):
 * a web tool naming it, a URL to it in any input, or a fetch command naming it in the same simple
 * command. Source text that only names it — a Go import path, a package name in a heredoc, a grep
 * pattern — reaches nothing.
 */
function reachesUpstream(text, frag, { web = false, command = false } = {}) {
  const low = text.toLowerCase();
  if (!low.includes(frag)) return false;
  // a longer name is another repository: `widget-extras` is not `widget`; a subdomain of the host
  // (`www.`, `codeload.`) is the same one
  const named = new RegExp(`(?:^|[^a-z0-9_.-])(?:[a-z0-9-]+\\.)*${escapeRe(frag)}(?![a-z0-9_-])`);
  if (!named.test(low)) return false;
  if (web) return true;
  if (new RegExp(`//(?:[^\\s/@]+@)?(?:[a-z0-9-]+\\.)*${escapeRe(frag)}(?![a-z0-9_-])`).test(low)) return true;
  if (!command) return false;
  for (const seg of splitCommands(unwrapShell(low))) {
    if (!named.test(seg)) continue;
    const cw = shellWords(seg).map(w => w.text);
    let i = 0;
    while (i < cw.length && (PREFIX_WORDS.has(cw[i]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(cw[i]))) i++;
    const name = cw[i] ? path.basename(cw[i]) : null;
    if (SHELLS.test(name ?? "") && /^-[a-z]*c[a-z]*$/.test(cw[i + 1] ?? "")) {
      if (reachesUpstream(cw.slice(i + 2).join(" "), frag, { command: true })) return true;
      continue;
    }
    if (FETCHERS.has(name)) return true;
    const sub = cw.slice(i + 1).find(w => !w.startsWith("-"));
    if (FETCH_SUBCOMMANDS[name]?.includes(sub)) return true;
    // `go run|list <module>@<version>` and `go list -m -versions|-u` ask the module proxy
    if (name === "go" && (sub === "run" || sub === "list")) {
      const args = cw.slice(i + 2);
      if (args.some(w => w.includes("@") && named.test(w))) return true;
      if (sub === "list" && args.includes("-m") && args.some(w => w === "-versions" || w === "-u")) return true;
    }
  }
  return false;
}

/**
 * A listed shared temp root (or a dir above a user's temp dir), or a glob among the root's entries:
 * where every run's temp dirs sit side by side. A glob above an entry with a name reaches that name only.
 */
function sharedTmp(p, lists, globs) {
  for (const [root, depth] of [["/tmp", 0], ["/var/folders", 3]]) {
    if (!under(p, root)) continue;
    const entry = path.relative(root, p).split("/").filter(Boolean)[depth];
    return entry === undefined ? lists : globs && GLOB.test(entry);
  }
  return false;
}

function strings(v, out = []) {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) strings(x, out);
  return out;
}

/**
 * Tool inputs of one event line: [{ commands: [string], paths: [string], texts: [string], web?, cwd? }].
 * `texts` are every string of the input (for the upstream check); `web`: a web search or fetch tool.
 */
function toolInputs(reviewer, d) {
  const out = [];
  if (reviewer === "codex") {
    const it = d.item;
    if (!it || (d.type !== "item.started" && d.type !== "item.completed")) return out;
    if (it.type === "command_execution") out.push({ commands: [it.command], paths: [], texts: [it.command] });
    else if (it.type === "file_change") out.push({ commands: [], paths: (it.changes ?? []).map(c => c.path).filter(Boolean), texts: strings(it.changes) });
    else if (it.type === "mcp_tool_call") out.push({ commands: [], paths: strings(it.arguments), texts: strings(it.arguments) });
    else if (it.type === "web_search") out.push({ commands: [], paths: [], texts: strings([it.query, it.action]), web: true });
  } else if (reviewer === "claude") {
    if (d.type !== "assistant") return out;
    for (const c of d.message?.content ?? []) {
      if (c.type !== "tool_use") continue;
      const input = c.input ?? {};
      out.push({
        commands: typeof input.command === "string" ? [input.command] : [],
        paths: ["file_path", "path", "notebook_path", "pattern"].map(k => input[k]).filter(v => typeof v === "string"),
        texts: strings(input),
        web: WEB_TOOL.test(c.name ?? ""),
      });
    }
  } else if (reviewer === "agy") {
    const params = d.event === "step_update" ? d.step_update?.tool_info?.parameters : null;
    if (!params) return out;
    const cmdKeys = ["CommandLine", "Command"];
    out.push({
      commands: cmdKeys.map(k => params[k]).filter(v => typeof v === "string"),
      // Cwd is where the command runs, judged on its own (running somewhere lists nothing)
      paths: Object.entries(params).filter(([k, v]) => !cmdKeys.includes(k) && k !== "Cwd" && typeof v === "string").map(([, v]) => v),
      texts: strings(params),
      web: WEB_TOOL.test(d.step_update?.tool_info?.name ?? ""),
      cwd: typeof params.Cwd === "string" ? params.Cwd : undefined,
    });
  }
  return out;
}

/** Event log files of a session: the live round and archived rounds. */
function eventFiles(sessionDir) {
  const files = [];
  if (fs.existsSync(path.join(sessionDir, "output.jsonl"))) files.push(path.join(sessionDir, "output.jsonl"));
  const outputs = path.join(sessionDir, "outputs");
  if (fs.existsSync(outputs)) {
    for (const f of fs.readdirSync(outputs).sort()) if (/^output-round-\d+\.jsonl$/.test(f)) files.push(path.join(outputs, f));
  }
  return files;
}

/**
 * Audit a run's session. ctx: { runDir, workspace, realHome, runRoot, tmpdir?, upstream: [url fragments] }.
 * Resolves { flagged, hits: [{reason, value, path}], checked, unparsed }.
 */
export function auditRun(sessionDir, reviewer, ctx) {
  return auditLogs(eventFiles(sessionDir), reviewer, ctx);
}

/** Audit event log files written in `reviewer`'s format (a Track C orchestrator's own log too). */
export function auditLogs(files, reviewer, ctx) {
  const runDir = canonical(ctx.runDir);
  const runHome = path.join(ctx.runDir, "home");
  const tmpDir = ctx.tmpdir ?? path.join(ctx.runDir, "tmp");
  const keychainLink = path.join(runDir, "home", "Library", "Keychains");
  const home = canonical(ctx.realHome);
  const runRoot = canonical(ctx.runRoot);
  // the run root in both spellings of /tmp and /var (`/private/tmp/crw` is the same dir)
  const runRootAbove = [runRoot, ...(/^\/(?:tmp|var)(?:\/|$)/.test(runRoot) ? [`/private${runRoot}`] : [])];
  const ws = ctx.workspace ?? ctx.runDir;
  // relative words without `..` stay safe only inside the workspace (the run home holds the Keychain link)
  const wsDir = canonical(ws);
  const upstream = (ctx.upstream ?? []).map(u => u.toLowerCase());
  const hits = [];
  const seen = new Set();
  const hit = (reason, value, p = null) => {
    const key = `${reason}\0${value}\0${p}`;
    if (!seen.has(key)) { seen.add(key); hits.push({ reason, value: String(value).slice(0, 300), path: p }); }
  };

  // lists/globs: whether the access lists `raw` and whether its * and [ are a glob (shared temp roots)
  // deep: the access descends below `raw` (a recursive listing or search; a tool's path counts as one)
  const judge = (value, raw, lists = true, globs = true, deep = true, byName = false) => {
    const p = canonical(raw);
    if (under(p, keychainLink) || under(p, path.join(home, "Library", "Keychains"))) return hit("keychain", value, p);
    if (under(p, runDir)) return;
    if (under(p, runRoot)) {
      // other runs are the 8-hex dirs; the root itself (opaque names) and plain names beside them
      // (Codex looks for AGENTS.md in every dir above the workspace) hold nothing of another run,
      // unless a listing or content search descends from the root into the run dirs
      const first = path.relative(runRoot, p).split("/")[0];
      if (RUN_DIR.test(first) || GLOB.test(first) || (first === "" && lists && deep && !byName)) return hit("other_run", value, p);
      return;
    }
    if (sharedTmp(p, lists, globs)) return hit("shared_tmp", value, p);
    // a recursive listing or search of a dir above the run root (`rg secret /`) descends into every run
    // dir; a search there by name only (`find / -name pytest`, a tool hunt) prints paths, not contents
    if (lists && deep && !byName && runRootAbove.some(r => under(r, p))) return hit("other_run", value, p);
    if (under(p, home)) {
      if (HOME_TOOLCHAIN.some(d => under(p, path.join(home, d)))) return;
      return hit("real_home", value, p);
    }
    if (p.startsWith("/Users/") || p.startsWith("/Volumes/")) return hit("user_data", value, p);
  };

  let checked = 0;
  let unparsed = 0;
  for (const file of files) {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let d;
      try { d = JSON.parse(line); } catch { unparsed++; continue; }
      for (const input of toolInputs(reviewer, d)) {
        checked++;
        // a tool's own cwd: `~` and `$HOME` are the run home, relative is from the workspace
        const cwd = input.cwd ? tokenPath(input.cwd.trim(), ws, runHome, true) ?? ws : ws;
        if (input.cwd) judge(input.cwd, cwd, false);
        const outside = !under(canonical(cwd), wsDir);
        for (const cmd of input.commands) {
          const { paths, banned } = analyzeCommand(cmd, cwd, runHome, wsDir, tmpDir);
          for (const b of banned) hit("banned_command", b);
          for (const p of paths) judge(p.value, p.path, p.lists, p.globs, p.deep, p.byName);
        }
        for (const v of input.paths) {
          const p = tokenPath(v.trim().replace(TMPDIR_VAR, tmpDir), cwd, runHome, outside);
          if (p) judge(v, p);
        }
        for (const t of input.texts) {
          const kind = { web: input.web, command: input.commands.includes(t) };
          for (const u of upstream) if (reachesUpstream(t, u, kind)) hit("upstream", t);
        }
      }
    }
  }
  return { flagged: hits.length > 0, hits, checked, unparsed };
}
