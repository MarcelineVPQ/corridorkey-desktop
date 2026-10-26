#!/usr/bin/env node
// Loop pass (rule 7, the AVIEW/DS5 pattern): every loop, iterator chain, timer, wait, thread and (on the
// Electron main process) blocking call carries exactly one verdict, so no waiting or hot loop goes unexamined.
// docs/LOOP_PASS_2026-10.md is the pass; its tables come from `--md`.
//
// Listed mechanically, tests excluded (tests/, *.test.*, test_*.py, Rust `#[cfg(test)]` modules):
//   electron/, src/, tools/, .hooks/ (.ts/.tsx/.mjs/.js, .sh), engine/ and the Python tools (.py),
//   engine-rs/crates/*/src (.rs), engine-rs/export (model export: .py, .sh), engine-rs/tools (.sh, .py, the ck-trt-build C++).
// Kinds (one row per line; a line with several gets them joined, e.g. loop+iter):
//   loop    for / while / do / loop statements (sh: for / while / until)
//   iter    iterator chains and array callbacks: Rust .iter() / .par_iter() / .into_iter() / .chunks*() /
//           (a..b).map ..., TS .map / .forEach / .filter / .reduce / .some / .every / .find* / .flatMap /
//           .sort, Python comprehensions
//   timer   setTimeout / setInterval / requestAnimationFrame, sleeps
//   wait    a blocking wait: child processes (output / status / wait / execFile / subprocess), channel
//           recv, thread join, blocking file reads, fetch
//   thread  a thread started (std::thread::spawn, threading.Thread)
//   sync    a synchronous fs / child call on the Electron main process (electron/main: blocks the UI)
// Flags (the special-attention column, mechanical):
//   no-timeout  a wait with no deadline in its call       retry      a loop that retries
//   spin        a poll loop with no sleep / block in it    alloc      allocates inside the loop / chain
//   nested      inside another loop / chain / timer        pixel      nested, and both run over w/h/rows/pixels
//   main-blocking  blocks the Electron main process
// A row flagged no-timeout, retry or spin must say what bounds it: `[bounded: ...]` in its reason.
//
// Rust (engine-rs/crates, .rs) needs a verdict only where one carries information (senior review 2026-10,
// finding 16): a wait, thread, timer (sleep) or blocking call; a plain `while` / `loop` statement (it can spin or
// wait); and a `for` loop or iterator chain flagged no-timeout, retry, spin, pixel, nested or alloc. A plain `for`
// or iterator chain with none of those flags (an `.iter().any()` over a few items) is exempt: it is still listed,
// as "exempt" when it has no verdict, and never fails the gate. Every other language: every row needs a verdict.
//
//   node tools/list_loops.mjs           TSV: file line kind verdict flags head
//   node tools/list_loops.mjs --check   the gate: exit 1 on a required row without a valid verdict (or bound)
//   node tools/list_loops.mjs --md      the pass doc's summary and per-file tables (markdown)
//
// A verdict is a comment on the row's line or on the comment lines right above it:
//   // loop: SERIAL-REQUIRED — one job at a time on one GPU
//   # loop: HOT-PATH-OK — N ≤ 6
//   {/* loop: HOT-PATH-OK — a few rows */}
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export const VERDICTS = ["PARALLELIZE", "BATCH", "SERIAL-REQUIRED", "HOT-PATH-OK", "FIX-HOT-PATH", "NOT-WORTH"];
export const ROOTS = ["electron", "src", "engine", "engine-rs/crates", "engine-rs/export", "engine-rs/tools", "tools", ".hooks"];
const VERDICT = new RegExp(`(//|#|\\{/\\*)\\s*loop: (${VERDICTS.join("|")}) — (.*?)\\s*(\\*/\\})?$`);

/** The language of a file, or null when it isn't listed. */
export function langOf(file) {
  if (/(\.test\.|\/test_[^/]*\.py$|\.d\.m?ts$)/.test(file)) return null;
  if (/\.(tsx?|mjs|js)$/.test(file)) return "ts";
  if (/\.rs$/.test(file)) return "rs";
  if (/\.py$/.test(file)) return "py";
  if (/\.(cpp|cc|hpp|h)$/.test(file)) return "cpp";
  if (/\.sh$/.test(file)) return "sh";
  return null;
}

const P = {
  ts: {
    loop: /^\s*(}\s*else\s+)?(for\s*\(|for await\s*\(|while\s*\(|do\s*\{)/,
    iter: /\.(map|forEach|filter|reduce|reduceRight|some|every|find|findIndex|findLast|flatMap|sort|toSorted)\(/,
    timer: /\b(setTimeout|setInterval|requestAnimationFrame)\(/,
    wait: /\b(execFileSync|execSync|spawnSync|execFile|fetch)\(|\brun\(\s*["'`]/,
    sync: /\b(?!execFileSync|execSync|spawnSync)\w+Sync\(/,
    thread: /\bnew Worker\(/,
    comment: /^\s*(\/\/|\/\*|\*|\{\/\*)/,
    alloc: /\bnew [A-Z]\w*|\.\.\.\w|JSON\.(stringify|parse)\(/,
  },
  rs: {
    loop: /^\s*('\w+:\s*)?(for .+ in .+\{|while .+\{|loop \{)/,
    iter: /\.(par_)?iter(_mut)?\(\)|\.into_(par_)?iter\(\)|\.(par_)?chunks(_exact)?(_mut)?\(|\.par_extend\(|\.chars\(\)|\.lines\(\)|\.bytes\(\)|\.windows\(|\.split\(|\(\s*[\w.]+\s*\.\.=?\s*[^()]*(\([^()]*\))?[^()]*\)\s*\.\s*(map|for_each|into_par_iter|filter|step_by|rev|flat_map|fold|any|all|find|position)\b/,
    timer: /thread::sleep\(/,
    wait: /\.recv\(\)|\.recv_timeout\(|\.join\(\)|\.wait\(\)|\.output\(\)|\.status\(\)|\.read_exact\(|\.read_to_end\(|\bwait_timeout\(|\boutput_timeout\(|\bjoined\(/,
    sync: null,
    thread: /thread::spawn\(|\bspawn_named\(|thread::Builder::new\(\)/,
    comment: /^\s*\/\//,
    alloc:
      /vec!\[|Vec::new\(|Vec::with_capacity\(|\.collect\b|\.to_vec\(\)|\.clone\(\)|format!\(|String::new\(|\.to_string\(\)|Box::new\(|Arc::new\(|\.into_owned\(\)|\.into_f(16|32)\(\)|\.range_f32\(/,
  },
  cpp: {
    loop: /^\s*(for\s*\(|while\s*\(|do\s*\{)/,
    iter: /std::(for_each|transform|accumulate)\(/,
    timer: /sleep_for\(|\busleep\(/,
    wait: /\.join\(\)|\bwaitpid\(/,
    sync: null,
    thread: /std::thread\b/,
    comment: /^\s*\/\//,
    alloc: /\bnew \w|std::vector<|std::string\(|\.push_back\(|\.emplace_back\(/,
  },
  py: {
    loop: /^\s*(async\s+)?(for .+ in .+:|while .+:)\s*(#.*)?$/,
    iter: /[[({].*\bfor\s+\S.*\s+in\s+\S.*[\])}]/,
    timer: /\btime\.sleep\(/,
    wait: /\bsubprocess\.(run|call|check_call|check_output)\(|\.communicate\(|\.wait\(|\.join\(\)|\bqueue\.get\(\)/,
    sync: null,
    thread: /threading\.Thread\(/,
    comment: /^\s*#/,
    alloc: /np\.(zeros|empty|ones|array|concatenate|stack)\(|\.copy\(\)|\.append\(/,
  },
  sh: {
    loop: /^\s*(for|while|until)\b/,
    iter: null,
    timer: /(^|[;&|]\s*|\s)sleep\s/,
    wait: /(^|[;&|]\s*)wait\b/,
    sync: null,
    thread: null,
    comment: /^\s*#/,
    alloc: null,
  },
};

const TIMEOUT = /timeout|recv_timeout|wait_timeout|output_timeout|AbortSignal|signal:|try_recv|try_wait/i;
const WAIT_HEAVY = { rs: /\.recv\(\)|\.join\(\)|\.wait\(\)|\.output\(\)|\.status\(\)/ };
const SPIN_POLL = /try_recv|try_wait|is_finished|try_lock/;
const SPIN_BLOCK = /sleep|recv_timeout|wait_timeout|\bPOLL\b|\.recv\(\)|await\b/;
const RETRY = /\b(retry|retries|retrying|attempts?)\b/i;
const PIXEL = /\b(w|h|wo|ho|sw|sh|ah|aw|width|height|plane|rows?|px|pixels?|x|y|oy|ox)\b/;

/** Code of a line without its trailing comment (rough: enough for the patterns above). */
function codeOf(line, lang) {
  if (lang === "py" || lang === "sh") return line.replace(/\s#.*$/, "");
  return line.replace(/(^|[^:"'])\/\/.*$/, "$1");
}

/**
 * The line span [start, end] of a row's body: a C-like loop's braces, a chain's statement, an indented Python
 * block, a shell do ... done. Rough on purpose: strings and comments are skipped well enough for this code.
 */
function spanOf(lines, i, lang, kind) {
  if (lang === "py") {
    const ind = lines[i].search(/\S/);
    let end = i;
    // loop: NOT-WORTH — the lines of one block, once per row while listing
    for (let k = i + 1; k < lines.length; k++) {
      if (!lines[k].trim()) continue;
      if (lines[k].search(/\S/) <= ind) break;
      end = k;
    }
    return [i, kind === "loop" ? end : i];
  }
  if (lang === "sh") {
    if (kind !== "loop") return [i, i];
    let depth = 0;
    // loop: NOT-WORTH — the lines of one block, once per row while listing
    for (let k = i; k < lines.length; k++) {
      const c = codeOf(lines[k], lang);
      depth += (c.match(/\bdo\b/g) || []).length - (c.match(/\bdone\b/g) || []).length;
      if (k > i - 1 && depth <= 0 && /\bdone\b/.test(c)) return [i, k];
    }
    return [i, i];
  }
  // C-like: track (), [], {} from the row's line on
  let depth = 0;
  let opened = false;
  // loop: NOT-WORTH — the lines of one statement, once per row while listing
  for (let k = i; k < lines.length; k++) {
    const c = codeOf(lines[k], lang)
      .replace(/"(\\.|[^"\\])*"/g, '""')
      .replace(/`(\\.|[^`\\])*`/g, "``")
      .replace(lang === "rs" ? /'(\\.|[^'\\])'/g : /'(\\.|[^'\\])*'/g, "''");
    // loop: NOT-WORTH — the characters of one line, once per row while listing
    for (const ch of c) {
      if ("([{".includes(ch)) {
        depth++;
        opened = true;
      } else if (")]}".includes(ch)) depth--;
      if (depth < 0) return [i, k];
    }
    const next = (lines[k + 1] ?? "").trim();
    if (opened && depth === 0 && !/^[.)\]}?]/.test(next) && !/^(\.|&&|\|\||\?\?|:)/.test(next)) return [i, k];
    if (!opened && kind !== "loop" && depth === 0) return [i, k];
  }
  return [i, lines.length - 1];
}

/** Flags that make a Rust `for` loop or iterator chain need a verdict. */
const RS_REQUIRED_FLAGS = ["no-timeout", "retry", "spin", "pixel", "nested", "alloc"];

/** Whether a row needs a verdict (see the header: Rust's plain `for` loops and chains are exempt). */
export function requiresVerdict(r, lang) {
  if (lang !== "rs") return true;
  if (/wait|thread|timer|sync/.test(r.kind)) return true;
  if (/^\s*('\w+:\s*)?(while\b|loop \{)/.test(r.head)) return true;
  // loop: NOT-WORTH — a row's flags (≤ 6)
  return r.flags.some((f) => RS_REQUIRED_FLAGS.includes(f));
}

/**
 * The verdict of row line `i`: on the line itself, or on the comment lines right above it. A row inside a
 * statement a formatter wrapped (a `.map(` continuation, the call after `return (`) takes the comment above the
 * statement's first line.
 */
function verdictOf(lines, i, lang) {
  const own = VERDICT.exec(lines[i]);
  if (own) return Object.assign(own, { at: i });
  const p = P[lang];
  let head = i;
  // loop: NOT-WORTH — at most six wrapped lines up to the statement's first line [bounded: i - head < 6]
  while (head > 0 && i - head < 6 && !p.comment.test(lines[head - 1]) && (/^\s*\./.test(lines[head]) || /([([=,]|=>)\s*$/.test(codeOf(lines[head - 1], lang)))) {
    head--;
  }
  if (head !== i && VERDICT.exec(lines[head])) return Object.assign(VERDICT.exec(lines[head]), { at: head });
  // loop: NOT-WORTH — at most six comment lines above a row
  for (let k = head - 1; k >= 0 && k >= head - 6; k--) {
    if (!P[lang].comment.test(lines[k])) break;
    const m = VERDICT.exec(lines[k]);
    if (m) return Object.assign(m, { at: k });
  }
  return null;
}

/** Every row of one file's text. */
export function scan(text, file) {
  const lang = langOf(file);
  if (!lang) return [];
  let lines = text.split("\n");
  if (lang === "rs") {
    // loop: NOT-WORTH — one file's lines, once per run
    const t = lines.findIndex((l, k) => /^\s*#\[cfg\(test\)\]/.test(l) && /^\s*mod tests/.test(lines[k + 1] ?? ""));
    if (t >= 0) lines = lines.slice(0, t);
  }
  const p = P[lang];
  const rows = [];
  // loop: NOT-WORTH — one file's lines, once per run
  lines.forEach((line, i) => {
    if (p.comment.test(line)) return;
    const code = codeOf(line, lang);
    const kinds = [];
    if (p.loop.test(code)) kinds.push("loop");
    if (p.iter && p.iter.test(code)) kinds.push("iter");
    if (p.timer && p.timer.test(code)) kinds.push("timer");
    if (p.wait && p.wait.test(code) && !/^\s*(pub(\([^)]*\))?\s+)?(async\s+)?(fn|function|def)\s/.test(code)) kinds.push("wait");
    if (p.thread && p.thread.test(code)) kinds.push("thread");
    if (p.sync && file.startsWith("electron/main/") && p.sync.test(code)) kinds.push("sync");
    if (!kinds.length) return;
    // a chain's continuation line (".zip(b.par_chunks_mut(w))") is part of the chain row above it
    const prev = rows[rows.length - 1];
    // loop: NOT-WORTH — a row's kinds (≤ 3)
    if (/^\s*\./.test(line) && kinds.every((k) => k === "iter") && prev && prev.kind.includes("iter") && prev.start < i && prev.end >= i) return;
    const kind = kinds.join("+");
    const [start, end] = spanOf(lines, i, lang, kinds[0]);
    // loop: NOT-WORTH — one row's span (a few lines)
    const body = lines
      .slice(start, end + 1)
      .map((l) => codeOf(l, lang))
      .join("\n");
    const call = lines.slice(i, Math.min(lines.length, i + 7)).join("\n");
    const m = verdictOf(lines, i, lang);
    rows.push({ file, line: i + 1, kind, start, end, body, call, verdict: m ? m[2] : "", reason: m ? m[3] : "", verdictLine: m ? m.at + 1 : 0, head: line.trim().slice(0, 110) });
  });
  // flags
  // loop: NOT-WORTH — one file's rows, once per run
  rows.forEach((r) => {
    const f = [];
    const isWait = r.kind.includes("wait");
    if (isWait && !TIMEOUT.test(r.call.split(/;\s*$/m)[0])) f.push("no-timeout");
    if (/loop/.test(r.kind) && SPIN_POLL.test(r.body) && !SPIN_BLOCK.test(r.body)) f.push("spin");
    if (/loop/.test(r.kind) && RETRY.test(r.body)) f.push("retry");
    const p = P[lang];
    if (p.alloc && /loop|iter|timer/.test(r.kind) && p.alloc.test(r.kind === "iter" ? r.body : r.body.split("\n").slice(1).join("\n") || r.body)) f.push("alloc");
    // loop: NOT-WORTH — one file's rows per row (≤ 60 × 60), once per run
    const outer = rows.find((o) => o !== r && /loop|iter|timer/.test(o.kind) && /loop|iter/.test(r.kind) && o.start < r.line - 1 && o.end >= r.line - 1);
    if (outer) {
      f.push("nested");
      if (PIXEL.test(codeOf(outer.head, lang)) && PIXEL.test(codeOf(r.head, lang)) && file.startsWith("engine-rs/")) f.push("pixel");
    }
    if (file.startsWith("electron/main/") && (r.kind.includes("sync") || (/loop|iter/.test(r.kind) && /\w+Sync\(/.test(r.body)))) f.push("main-blocking");
    r.flags = f;
    r.required = requiresVerdict(r, lang);
  });
  // loop: NOT-WORTH — one file's rows, once per run
  return rows.map(({ start, end, body, call, ...r }) => r);
}

/** Every listed file under the roots. */
export function listFiles(root = ".") {
  const files = [];
  const walk = (dir) => {
    let names;
    try {
      names = readdirSync(join(root, dir));
    } catch {
      // error: NOT-WORTH — a root that doesn't exist in this checkout has nothing to list
      return;
    }
    // loop: NOT-WORTH — the files of the repo's source folders, once per run
    for (const name of names) {
      const p = join(dir, name);
      if (statSync(join(root, p)).isDirectory()) {
        if (!["__pycache__", "tests", "target", "node_modules", "fixtures", "build", "include"].includes(name)) walk(p);
      } else if (langOf(p)) files.push(p);
    }
  };
  // loop: NOT-WORTH — eight roots
  ROOTS.forEach(walk);
  // loop: NOT-WORTH — ~100 files
  return files.sort();
}

export function listAll(root = ".") {
  // loop: NOT-WORTH — ~100 files, once per run
  return listFiles(root).flatMap((f) => scan(readFileSync(join(root, f), "utf8"), f));
}

/** Gate problems: required rows without a verdict, or flagged ones that don't say what bounds them. */
export function problems(rows) {
  const out = [];
  // loop: NOT-WORTH — once per gate run over the rows (its "retry" is the flag's name) [bounded: the rows]
  for (const r of rows) {
    if (!r.verdict && r.required) out.push(`${r.file}:${r.line}: ${r.kind} without a verdict (// loop: VERDICT — reason): ${r.head}`);
    // loop: NOT-WORTH — three flags per row
    else if (r.verdict && r.flags.some((f) => ["no-timeout", "retry", "spin"].includes(f)) && !/\[bounded: [^\]]+\]/.test(r.reason))
      out.push(`${r.file}:${r.line}: ${r.flags.join(",")} needs [bounded: what ends it] in its reason: ${r.head}`);
  }
  return out;
}

const esc = (s) => s.replace(/\|/g, "\\|");
/** The verdict column: the verdict, "exempt" for an exempt row without one, else none. */
const verdictText = (r, none) => r.verdict || (r.required ? none : "exempt");

export function markdown(rows) {
  // loop: NOT-WORTH — six verdicts
  const byVerdict = Object.fromEntries(VERDICTS.map((v) => [v, 0]));
  // loop: NOT-WORTH — the rows, once per doc build
  rows.forEach((r) => r.verdict && byVerdict[r.verdict]++);
  const kinds = {};
  // loop: NOT-WORTH — the rows, once per doc build
  rows.forEach((r) => r.kind.split("+").forEach((k) => (kinds[k] = (kinds[k] ?? 0) + 1)));
  const flags = {};
  // loop: NOT-WORTH — the rows, once per doc build
  rows.forEach((r) => r.flags.forEach((f) => (flags[f] = (flags[f] ?? 0) + 1)));
  const area = (f) => (f.startsWith("engine-rs/") ? "engine-rs" : f.split("/")[0]);
  // loop: NOT-WORTH — the rows, once per doc build
  const areas = [...new Set(rows.map((r) => area(r.file)))];
  const out = [];
  // loop: NOT-WORTH — a few areas
  out.push(`| Verdict | ${areas.join(" | ")} | All |`, `|---|${areas.map(() => "---|").join("")}---|`);
  // loop: NOT-WORTH — six verdicts × a few areas, once per doc build
  for (const v of VERDICTS) out.push(`| ${v} | ${areas.map((a) => rows.filter((r) => area(r.file) === a && r.verdict === v).length).join(" | ")} | ${byVerdict[v]} |`);
  const exempt = (r) => !r.verdict && !r.required;
  // loop: NOT-WORTH — a few areas × the rows, once per doc build
  out.push(`| exempt (Rust, no verdict needed) | ${areas.map((a) => rows.filter((r) => area(r.file) === a && exempt(r)).length).join(" | ")} | ${rows.filter(exempt).length} |`);
  // loop: NOT-WORTH — a few areas × the rows, once per doc build
  out.push(`| **Total** | ${areas.map((a) => rows.filter((r) => area(r.file) === a).length).join(" | ")} | **${rows.length}** |`, "");
  // loop: NOT-WORTH — a few kinds
  const kindText = Object.entries(kinds).map(([k, n]) => `${k} ${n}`);
  // loop: NOT-WORTH — a few flags
  const flagText = Object.entries(flags).map(([k, n]) => `${k} ${n}`);
  out.push(`Kinds: ${kindText.join(", ")}. Flags: ${flagText.join(", ") || "none"}.`, "");
  // loop: NOT-WORTH — the rows, once per doc build
  const files = [...new Set(rows.map((r) => r.file))];
  // loop: NOT-WORTH — the listed files, once per doc build
  for (const f of files) {
    out.push(`#### ${f}`, "", "| Line | Kind | Verdict | Special attention | Reason | Code |", "|---|---|---|---|---|---|");
    // loop: NOT-WORTH — the rows per file, once per doc build
    rows
      .filter((r) => r.file === f)
      .forEach((r) => out.push(`| ${r.line} | ${r.kind} | ${verdictText(r, "**none**")} | ${r.flags.join(", ")} | ${esc(r.reason)} | \`${esc(r.head.replace(/`/g, "'"))}\` |`));
    out.push("");
  }
  return out.join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const rows = listAll();
  if (process.argv.includes("--check")) {
    const bad = problems(rows);
    if (bad.length) {
      console.log(`Loop gate: ${bad.length} row(s) without a valid verdict:`);
      // loop: NOT-WORTH — the gate's problems
      bad.forEach((b) => console.log(b));
      process.exit(1);
    }
    // loop: NOT-WORTH — the rows, once per run
    const required = rows.filter((r) => r.required).length;
    console.log(
      `Loop gate: ${rows.length} rows (loops, chains, timers, waits, threads, main-process calls): ${required} need a verdict and have one, ${rows.length - required} exempt (plain Rust loops and chains).`,
    );
  } else if (process.argv.includes("--md")) console.log(markdown(rows));
  // loop: NOT-WORTH — the rows, once per run
  else rows.forEach((r) => console.log([r.file, r.line, r.kind, verdictText(r, "-"), r.flags.join(",") || "-", r.head].join("\t")));
}
