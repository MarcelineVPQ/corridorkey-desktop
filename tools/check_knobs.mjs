#!/usr/bin/env node
// Engine knob gate (audit row 16): every CK_ENGINE_* environment variable is in docs/ENGINE_RUST.md. Sources of
// truth: the variables the engine reads (`"CK_ENGINE_…"` literals in engine-rs/crates/*/src, without tests) and the
// ones the app reads or sets (CK_ENGINE_… in electron/ and src/, without tests). It fails when
//   (a) one of them isn't in docs/ENGINE_RUST.md;
//   (b) docs/ENGINE_RUST.md names one that neither the engine nor the app uses any more.
//   node tools/check_knobs.mjs    the gate (npm run gates)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
const DOC = "docs/ENGINE_RUST.md";

/** The CK_ENGINE_* names in a text (`quoted`: only as a string literal's start, as Rust reads them). */
export function knobs(text, quoted = false) {
  // loop: NOT-WORTH — a few names per file
  return [...text.matchAll(quoted ? /"(CK_ENGINE_[A-Z0-9_]+)"/g : /\b(CK_ENGINE_[A-Z0-9_]+)/g)].map((m) => m[1]);
}

export function checkKnobs(engine, app, doc) {
  const documented = new Set(knobs(doc));
  const used = new Set([...engine, ...app]);
  const out = [];
  // loop: NOT-WORTH — a score of names
  for (const k of [...used].sort()) if (!documented.has(k)) out.push(`${k} (${engine.includes(k) ? "the engine reads it" : "the app uses it"}) isn't in ${DOC}`);
  // loop: NOT-WORTH — a score of names
  for (const k of [...documented].sort()) if (!used.has(k)) out.push(`${DOC} names ${k}, which nothing reads any more`);
  return out;
}

/** The files under `dir` matching `ext`, without tests (a `tests` folder, *.test.*, a Rust `#[cfg(test)] mod tests`). */
function sources(app, dir, ext) {
  const out = [];
  const walk = (d) => {
    // loop: NOT-WORTH — the source folders' entries, once per gate run
    for (const n of readdirSync(join(app, d))) {
      const p = join(d, n);
      if (statSync(join(app, p)).isDirectory()) {
        if (n !== "tests") walk(p);
      } else if (ext.test(n) && !/\.test\./.test(n)) {
        const text = readFileSync(join(app, p), "utf8");
        const t = text.search(/^\s*#\[cfg\(test\)\]\s*\n\s*mod tests/m);
        out.push(t < 0 ? text : text.slice(0, t));
      }
    }
  };
  walk(dir);
  return out;
}

export function checkAll(app = APP) {
  // loop: NOT-WORTH — the crates' source files, once per gate run
  const engine = sources(app, "engine-rs/crates", /\.rs$/).flatMap((t) => knobs(t, true));
  // loop: NOT-WORTH — the app's source files, once per gate run
  const appKnobs = [...sources(app, "electron", /\.tsx?$/), ...sources(app, "src", /\.tsx?$/)].flatMap((t) => knobs(t));
  return checkKnobs(engine, appKnobs, readFileSync(join(app, DOC), "utf8"));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const problems = checkAll();
  if (problems.length) {
    console.log(`Engine knob gate (${DOC}, tools/check_knobs.mjs):\n` + problems.join("\n"));
    process.exit(1);
  }
}
