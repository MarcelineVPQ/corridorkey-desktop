#!/usr/bin/env node
// Shared-sentence gate (audit row 13): a sentence src/shared/texts.ts defines is written only there. Source of truth:
// its `export const NAME = "…"` strings. It fails when the code of another file in src/ or electron/ (comments and
// tests don't count) has one of them, as written or with its first letter in lower case (lowerFirst's form):
// use the constant.
//   node tools/check_texts.mjs    the gate (npm run gates)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEXTS = "src/shared/texts.ts";

/** texts.ts's plain string constants: [{ name, text }]. */
export function sharedTexts(ts) {
  // loop: NOT-WORTH — a dozen constants
  return [...ts.matchAll(/^export const (\w+) =\s*"((?:[^"\\]|\\.)+)";/gm)].map((m) => ({ name: m[1], text: m[2].replace(/\\(.)/g, "$1") }));
}

/** A source without its comments (line comments not inside a URL, block and JSX comments). */
export function codeOnly(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\w"'`])\/\/.*$/gm, "$1");
}

/** The shared sentences one file's code repeats. */
export function checkFile(path, src, texts) {
  const code = codeOnly(src);
  // loop: NOT-WORTH — a dozen sentences per file
  return texts
    .filter(({ text }) => code.includes(text) || code.includes(text.charAt(0).toLowerCase() + text.slice(1)))
    .map(({ name, text }) => `${path}: writes "${text}" itself; use ${name} from ${TEXTS} (lowerFirst() inside a line)`);
}

export function checkAll(app = APP) {
  const texts = sharedTexts(readFileSync(join(app, TEXTS), "utf8"));
  if (!texts.length) return [`check_texts: found no sentences in ${TEXTS} (moved?)`];
  const out = [];
  const walk = (d) => {
    // loop: NOT-WORTH — the source folders' entries, once per gate run
    for (const n of readdirSync(join(app, d))) {
      const p = join(d, n);
      if (statSync(join(app, p)).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(n) && !/\.(test|d)\.tsx?$/.test(n) && p !== TEXTS) out.push(...checkFile(p, readFileSync(join(app, p), "utf8"), texts));
    }
  };
  walk("src");
  walk("electron");
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const problems = checkAll();
  if (problems.length) {
    console.log("Shared-sentence gate (src/shared/texts.ts, tools/check_texts.mjs):\n" + problems.join("\n"));
    process.exit(1);
  }
}
