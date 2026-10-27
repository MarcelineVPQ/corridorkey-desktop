#!/usr/bin/env node
// Farm submitter gate (audit row 12): the example submitters in farm/ (Deadline, OpenJD, OpenCue, Flamenco, shell)
// pass the `corridorkey` command line only flags it has. Source of truth: src/shared/console/cliSpec.json (the CLI's
// own `__spec --json`). It fails when a file in farm/ (not README.md, not the sample job files)
//   (a) has a long flag (`--x`) that is neither a CLI flag nor one of the file's own options (Python
//       `add_argument("--x"`, a shell `case` pattern `--x)`);
//   (b) gives `--progress-format` a value the CLI doesn't take.
//   node tools/check_farm_submitters.mjs    the gate (npm run gates)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const APP = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The CLI's long flags and --progress-format's values, from its spec. */
export function cliFlags(spec) {
  const flags = new Set();
  let formats = [];
  // loop: NOT-WORTH — the CLI's few commands
  for (const c of spec.commands) {
    // loop: NOT-WORTH — one command's flags
    for (const a of c.args) {
      if (a.long) flags.add(a.long);
      if (a.long === "progress-format") formats = a.possible_values ?? [];
    }
  }
  return { flags, formats };
}

/** (a) and (b) for one submitter file. */
export function checkFile(path, text, { flags, formats }) {
  const own = new Set();
  // loop: NOT-WORTH — a submitter's own options (a dozen)
  for (const m of text.matchAll(/add_argument\((?:\s*["']-\w["'],)?\s*["']--([\w-]+)["']|(?:^|\|)\s*--([\w-]+)\s*\)/gm)) own.add(m[1] ?? m[2]);
  const out = [];
  const seen = new Set();
  // loop: NOT-WORTH — one file's flags
  for (const m of text.matchAll(/(?<![\w-])--([a-z][a-z0-9-]*)/g)) {
    const f = m[1];
    if (seen.has(f)) continue;
    seen.add(f);
    if (!flags.has(f) && !own.has(f)) out.push(`${path}: --${f} is neither a corridorkey flag (cliSpec.json) nor one of this file's own options`);
  }
  // loop: NOT-WORTH — a few progress formats per file
  for (const m of text.matchAll(/--progress-format["',\s-]+([a-z]+)/g)) {
    if (!formats.includes(m[1])) out.push(`${path}: --progress-format ${m[1]} isn't one of the CLI's (${formats.join(", ")})`);
  }
  return out;
}

export function checkAll(app = APP) {
  const cli = cliFlags(JSON.parse(readFileSync(join(app, "src/shared/console/cliSpec.json"), "utf8")));
  const out = [];
  const walk = (d) => {
    // loop: NOT-WORTH — farm/'s few files, once per gate run
    for (const n of readdirSync(join(app, d))) {
      const p = join(d, n);
      if (statSync(join(app, p)).isDirectory()) walk(p);
      else if (n !== "README.md" && !n.endsWith(".txt")) out.push(...checkFile(p, readFileSync(join(app, p), "utf8"), cli));
    }
  };
  walk("farm");
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const problems = checkAll();
  if (problems.length) {
    console.log("Farm submitter gate (farm/, tools/check_farm_submitters.mjs):\n" + problems.join("\n"));
    process.exit(1);
  }
}
