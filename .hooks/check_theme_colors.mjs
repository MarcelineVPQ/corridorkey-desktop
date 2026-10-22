#!/usr/bin/env node
// Pre-commit / CI gate: one theme system (rule 2; adapted from the DS5 app).
//
// Every color in app CSS and components comes from the theme tokens in
// src/styles/tokens.css (--bg-*, --text-*, --border-*, --accent, --status-*),
// so light/dark and any later theme restyle everything. This blocks a
// literal color (#hex, rgb()/rgba(), named) anywhere except:
//   - a token definition (a line that sets a --custom-property);
//   - a neutral shadow: pure black with alpha in a box-/text-shadow or filter;
//   - a line marked `theme-exempt: <reason>`; listed by `--list`;
//   - a token source (TOKEN_SOURCES below): the .ts files whose job is to hold
//     the palettes the tokens are built from. Exempt by path, listed by `--list`.
// It walks .css, .tsx and .ts.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["src", "electron"];
const SKIP = [/\.test\./, /\.d\.ts$/];
// Token sources: each file here IS a palette, so a literal color in it is the
// point, not a violation. Keep this list short; anything else marks its lines.
const TOKEN_SOURCES = new Map([
  ["src/ui/theme/palette.ts", "builds the Desktop theme's tokens from the desktop's colors"],
  ["src/ui/glass/liquidGlass.ts", "the glass filter's displacement map (channel values, not colors)"],
]);
const COLOR = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|(?<![\w-])(white|black|red|green|blue|orange|yellow|purple|gray|grey)(?![\w-])/;
const SHADOW_BLACK = /\brgba?\(\s*0[ ,]+0[ ,]+0\s*(\/|,)/g;

const files = [];
const walk = (dir) => {
  // loop: NOT-WORTH — the source folders' entries, once per gate run
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    // loop: NOT-WORTH — a few skip patterns per file, once per gate run
    else if (/\.(css|tsx?)$/.test(p) && !SKIP.some((r) => r.test(p))) files.push(p);
  }
};
// loop: NOT-WORTH — two roots
ROOTS.forEach(walk);
// loop: NOT-WORTH — a few token sources
const staleSources = [...TOKEN_SOURCES.keys()].filter((f) => !files.includes(f));
if (staleSources.length) {
  console.log(`Theme gate: TOKEN_SOURCES lists files that aren't walked (moved or deleted?): ${staleSources.join(", ")}`);
  process.exit(1);
}

const hits = [];
// loop: NOT-WORTH — a few token sources
const exempt = [...TOKEN_SOURCES].map(([file, why]) => `${file}: (whole file) token source: ${why}`);
const check = (file, startLine, text, rawText) => {
  if (!COLOR.test(text)) return;
  const where = `${file}:${startLine}: ${rawText.trim().replace(/\s+/g, " ").slice(0, 160)}`;
  if (/^\s*--[\w-]+\s*:/.test(text)) return; // token definition
  if (/(box-shadow|text-shadow|filter)\s*:/.test(text) && !COLOR.test(text.replace(SHADOW_BLACK, "x("))) return;
  if (/theme-exempt:/.test(rawText)) {
    exempt.push(where);
    return;
  }
  hits.push(where);
};
// loop: NOT-WORTH — the source files, once per gate run
for (const file of files) {
  if (TOKEN_SOURCES.has(file)) continue;
  const source = readFileSync(file, "utf8");
  if (file.endsWith(".css")) {
    // One declaration (up to ; { or }) at a time, so a marker anywhere in a
    // multi-line value covers it (the formatter moves comments around).
    const noComments = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
    let start = 0;
    // loop: NOT-WORTH — one file's characters, once per gate run (comment stripping)
    for (let k = 0; k <= noComments.length; k++) {
      const ch = noComments[k];
      if (k === noComments.length || ch === ";" || ch === "{" || ch === "}") {
        const text = noComments.slice(start, k);
        // ...plus the rest of the line it ends on (where a trailing marker sits).
        const eol = source.indexOf("\n", k);
        const raw = source.slice(start, eol < 0 ? source.length : eol);
        if (ch !== "{") {
          const lead = text.length - text.trimStart().length;
          const line = source.slice(0, start + lead).split("\n").length;
          check(file, line, text, raw);
        }
        start = k + 1;
      }
    }
  } else {
    // loop: NOT-WORTH — one file's lines, once per gate run
    source.split("\n").forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, "");
      if (!/(style=|color|background|fill|stroke|Color|#[0-9a-fA-F]{6}")/.test(code)) return;
      if (/^\s*(import|export type|\*)/.test(code)) return;
      check(file, i + 1, code, line);
    });
  }
}

if (process.argv.includes("--list")) {
  console.log(exempt.join("\n"));
  process.exit(0);
}
if (hits.length) {
  console.log("Theme gate: literal color outside the theme tokens (use a token, or mark the line 'theme-exempt: <reason>')");
  console.log(hits.join("\n"));
  process.exit(1);
}
