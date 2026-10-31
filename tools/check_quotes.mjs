#!/usr/bin/env node
// Quotes gate (Marcy 2026-10-30: her words stay out of the public repo): no tracked text file quotes Marcy or the owner.
// Source of truth: `git ls-files`. It fails on a line where "Marcy" or "owner" is followed, in the same sentence, by a
// colon or said / asked / wrote and then a double-quoted phrase of 8+ letters; on the name, an optional date and an
// opening bracket or colon right before a quote (the backlog's Source shape); a sentence or quote running past the
// line's end is read on into the next two lines (in source files, comment lines only). A quoted phrase that is a term,
// label or title (one word, title-cased, or a digit with few lowercase words: a UI label, a log line, a version) isn't
// speech and passes. A line marked `quote-ok: <reason>` (or one of the two after it) passes.
// Write the decision or the fact in plain words instead, keeping "Marcy <date>".
//   node tools/check_quotes.mjs    the gate (npm run gates)
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const APP = join(dirname(fileURLToPath(import.meta.url)), "..");

// Tracked paths that aren't read, and why
export const SKIP = new Map([
  ["engine-rs/vendor/", "vendored third-party sources (OpenColorIO and its dependencies): not our text"],
  ["licenses/", 'third-party licence texts, verbatim (their "Copyright Owner" is a legal term)'],
  ["THIRD_PARTY_NOTICES.md", "generated from the third-party licences (tools/gen_notices.mjs), verbatim"],
  ["tests/unit/checkQuotes.test.ts", "this gate's unit test: its fixtures are made-up quotes the gate must catch"],
  ["tools/check_quotes.mjs", "this gate's own source: its comments and skip reasons describe the patterns it catches"],
]);
const BINARY = /\.(png|jpe?g|webp|gif|ico|icns|svg|exr|tiff?|mp4|mov|onnx|bin|zip|gz|xz|pdf|ttf|otf|woff2?|lock)$|package-lock\.json$/i;

const QUOTE = /["“]([^"“”\n]*)["”]/g;
const NAME = /\b(?:Marcy|[Oo]wner)\b/g;
// the name, an optional 's or date, then an opening bracket or colon (or nothing) right before the quote
const SHAPE = /\b(?:Marcy|[Oo]wner)\b(?:'s)?,?\s*(?:\d{4}-\d{2}-\d{2})?\s*[,:(]?\s*["“]([^"“”]*)/g;
const LEAD = /\b(?:said|says|asked|asks|wrote|writes)\b|:/;
// a sentence ends at ". " / "! " / "? " before a capital, or at a table cell's edge
const END = /[.!?]\s+(?=[*_`(["]*[A-Z])|\s\|\s/;
const SMALL = new Set(["a", "an", "the", "of", "to", "in", "on", "at", "for", "and", "or", "by", "as", "from", "with", "is", "it", "up", "out"]);
// a source file (its lines are code unless a comment) and a comment line
const CODE = /\.(m?[jt]sx?|rs|sh|py|css|c|cpp|h|hpp|nsh|toml|ya?ml)$/;
const COMMENT = /^\s*(\/\/|#|\*|\/\*|<!--)/;
const letters = (s) => (s.match(/\p{L}/gu) || []).length;

/** True for a phrase that is a term, label or title, not someone's words: one word (a term), a digit with under 6
 * lowercase words (a log line, a version, a size), or title-cased (its first word and at least half its words of 4+
 * letters capitalised). */
export function notSpeech(phrase) {
  const w = phrase.match(/[\p{L}'’-]+/gu) || [];
  if (w.length < 2) return true;
  // loop: NOT-WORTH — one phrase's few words
  if (/\d/.test(phrase) && w.filter((x) => x.length >= 3 && /^\p{Ll}/u.test(x)).length < 6) return true;
  // loop: NOT-WORTH — one phrase's few words
  const long = w.filter((x) => x.length >= 4 && !SMALL.has(x.toLowerCase()));
  // loop: NOT-WORTH — as above
  return w.length > 0 && /^\p{Lu}/u.test(w[0]) && long.filter((x) => /^\p{Lu}/u.test(x)).length * 2 >= long.length;
}

const speech = (phrase) => letters(phrase) >= 8 && !notSpeech(phrase);

/** The quoted phrases that quote Marcy or the owner, from a name on line `i` (its sentence read on into the next two
 * lines: in a source file only while they are comment lines, so code's own quote marks never pair with a comment's);
 * none when those lines say quote-ok. */
export function quotesIn(lines, i, code = false) {
  let text = lines[i];
  // loop: NOT-WORTH — at most 2 more lines (a sentence or quote running on), comment markers dropped
  for (let j = i + 1; j <= i + 2 && j < lines.length && lines[j].trim() && !(code && !(COMMENT.test(lines[j - 1]) && COMMENT.test(lines[j]))); j++)
    text += " " + lines[j].replace(/^\s*(\/\/\/?|#|\*|<!--)?\s*/, "");
  if (/quote-ok:/.test(text)) return [];
  const bad = new Set();
  const own = lines[i].length; // only a name on this line counts: the next lines are read for its sentence
  // loop: NOT-WORTH — a few lines' matches
  for (const m of text.matchAll(SHAPE)) if (m.index < own && speech(m[1].split(/["\u201d]/)[0])) bad.add(m[1].split(/["\u201d]/)[0]);
  // loop: NOT-WORTH — the name's few mentions on one line
  for (const n of text.matchAll(NAME)) {
    if (n.index >= own) break;
    const sentence = text.slice(n.index + n[0].length).split(END)[0];
    const lead = sentence.search(LEAD);
    if (lead < 0) continue;
    // loop: NOT-WORTH — one sentence's quoted phrases
    for (const q of sentence.slice(lead).matchAll(QUOTE)) if (speech(q[1])) bad.add(q[1]);
  }
  return [...bad];
}

/** files: [{ name, text }]: one problem per line that quotes Marcy or the owner. */
export function checkFiles(files) {
  const out = [];
  // loop: NOT-WORTH — the repository's text files, once per gate run
  for (const f of files) {
    const lines = f.text.split("\n");
    // loop: NOT-WORTH — one file's lines
    for (let i = 0; i < lines.length; i++) {
      if (/quote-ok:/.test(lines[i]) || !/\b(?:Marcy|[Oo]wner)\b/.test(lines[i])) continue;
      const bad = quotesIn(lines, i, CODE.test(f.name));
      if (bad.length)
        out.push(
          `${f.name}:${i + 1}: quotes words next to Marcy or the owner ("${bad[0].slice(0, 60)}"): write the decision or fact in plain words, keeping "Marcy <date>", or mark the line quote-ok: <reason> if the words aren't hers`,
        );
    }
  }
  return out;
}

/** The tracked text files the gate reads. */
export function trackedFiles(app = APP) {
  // loop: NOT-WORTH — one git call per gate run [bounded: timeout 20 s]
  const names = execFileSync("git", ["ls-files", "-z"], { cwd: app, encoding: "utf8", timeout: 20_000, maxBuffer: 64 * 1024 * 1024 }).split("\0");
  const files = [];
  // loop: NOT-WORTH — the tracked paths, once per gate run
  for (const name of names) {
    // loop: NOT-WORTH — four prefixes
    if (!name || BINARY.test(name) || [...SKIP.keys()].some((p) => name === p || (p.endsWith("/") && name.startsWith(p)))) continue;
    let text;
    try {
      text = readFileSync(join(app, name), "utf8");
    } catch {
      continue; // deleted in the working tree, or a submodule
    }
    if (!text.includes("\0")) files.push({ name, text });
  }
  return files;
}

export function checkAll(app = APP) {
  return checkFiles(trackedFiles(app));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const problems = checkAll();
  if (problems.length) {
    console.log("Quotes gate (tools/check_quotes.mjs):\n" + problems.join("\n"));
    process.exit(1);
  }
}
