#!/usr/bin/env node
// The command line's parity gate (Marcy 2026-10-27: a build gate for the command line, so no new
// feature is left out of it). docs/cli-parity.json gives every field of the engine's run request a verdict: the
// `corridorkey` flags that set it, or "not-on-cli" with the reason; and every other render/verify flag ("cli-only")
// what it is for. Offline: it reads only this repository's sources. It fails when
//   (a) the engine reads a run request field (ck-core job.rs parse) the manifest doesn't list;
//   (b) a manifest flag isn't in the CLI (src/shared/console/cliSpec.json, the CLI's own `__spec --json`), a
//       render/verify flag isn't in the manifest, or the manifest and the CLI's own table (ck-cli args.rs RUN_OPTIONS,
//       OTHER_OPTIONS) disagree on which field a flag sets;
//   (c) a field the app sends (electron/main/queue.ts engineOptions) has no flag, or Copy as command's table
//       (src/shared/console/jobCommand.ts jobFlags) doesn't write it, or farm export (electron/main/console/farm.ts)
//       doesn't take its flags from that table;
//   (d) a manifest entry is stale: its field is gone from the engine, or it has no verdict, or two.
// tests/unit/jobCommand.test.ts and farmExport.test.ts check the behaviour (a job's line gives the engine the
// app's own request); docs/CLI.md "Adding an option" has the four places.
//
//   node tools/check_cli_parity.mjs   the gate (npm run gates)
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const APP = join(dirname(fileURLToPath(import.meta.url)), "..");

const ADD = "add it to docs/cli-parity.json";
const NEW_FLAG = "add the flag to engine-rs/crates/ck-cli/src/args.rs (RUN_OPTIONS), then node tools/gen_cli_spec.mjs";

/** The text of `fn`'s body in TS/Rust source: from its header to the first line that is a lone `}`. */
function body(src, header) {
  const at = src.indexOf(header);
  if (at < 0) return "";
  const end = src.indexOf("\n}\n", at);
  return src.slice(at, end < 0 ? undefined : end);
}

/** The run request fields the engine reads (job.rs, tests left out): `s("input")` at the top, `(o, "key"` and `o.get("key")` in options. */
export function engineFields(jobRs) {
  const src = jobRs.split("#[cfg(test)]")[0];
  // loop: NOT-WORTH — the request's ~40 fields, once per gate run
  const found = [...src.matchAll(/\bs\("(\w+)"\)|\bo,\s*"(\w+)"|\bo\.(?:get|contains_key)\("(\w+)"\)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
  return [...new Set(found)];
}

/** render's and verify's long flags (hidden and positional ones left out), as --name. */
export function jobCommandFlags(spec) {
  const out = new Set();
  // loop: NOT-WORTH — two commands' ~50 flags
  for (const c of spec.commands.filter((c) => c.name === "render" || c.name === "verify")) for (const a of c.args) if (!a.hidden && !a.positional && a.long) out.add(`--${a.long}`);
  return out;
}

/** The CLI's own flag → field pairs: args.rs RUN_OPTIONS ("flag", "field", …) and OTHER_OPTIONS ("field", "--flag"). */
export function cliTable(argsRs) {
  // loop: NOT-WORTH — ~35 tuples
  const run = [...argsRs.matchAll(/\("([a-z-]+)", "([a-z_]+)", Kind::/g)].map((m) => [`--${m[1]}`, m[2]]);
  const other = body(argsRs, "pub const OTHER_OPTIONS");
  // loop: NOT-WORTH — five tuples
  return [...run, ...[...other.matchAll(/\("([a-z_]+)", "(--[a-z-]+)"\)/g)].map((m) => [m[2], m[1]])];
}

/** The fields the app sends the engine for a job (queue.ts engineOptions: `key: o.…` and `out.key =`). */
export function appFields(queueTs) {
  const src = body(queueTs, "export function engineOptions(");
  // loop: NOT-WORTH — ~20 fields
  return [...new Set([...src.matchAll(/^\s+(\w+): o\.|\bout\.(\w+) =/gm)].map((m) => m[1] ?? m[2]))];
}

/** The flag names Copy as command's table writes (string literals in jobCommand.ts jobFlags), as --name. */
export function writerFlags(jobCommandTs) {
  // loop: NOT-WORTH — the table's ~30 literals
  return new Set([...body(jobCommandTs, "export function jobFlags(").matchAll(/"([a-z][a-z-]*)"/g)].map((m) => `--${m[1]}`));
}

/** Every rule, on the given sources. `manifest`: docs/cli-parity.json; `farmTs`: farm.ts's source. */
export function checkParity({ manifest, engine, spec, table, app, writer, farmTs }) {
  const problems = [];
  const fields = manifest.fields ?? {};
  const cliOnly = manifest["cli-only"] ?? {};
  const cli = jobCommandFlags(spec);
  const M = "docs/cli-parity.json";
  // (a) every engine field has a verdict
  // loop: NOT-WORTH — ~40 fields
  for (const f of engine) if (!fields[f]) problems.push(`(a) the engine reads \`${f}\` (ck-core job.rs) and ${M} has no verdict for it: ${ADD} with its flags, or "not-on-cli": "<why>" (${NEW_FLAG})`);
  // (d) stale or malformed entries
  // loop: NOT-WORTH — ~40 entries
  for (const [f, v] of Object.entries(fields)) {
    if (!engine.includes(f)) problems.push(`(d) ${M}: \`${f}\` isn't a field the engine reads any more (ck-core job.rs): remove it`);
    const hasFlags = Array.isArray(v.flags) && v.flags.length > 0;
    const hasWhy = typeof v["not-on-cli"] === "string" && v["not-on-cli"].trim() !== "";
    if (hasFlags === hasWhy) problems.push(`(d) ${M}: \`${f}\` needs exactly one verdict: "flags": ["--…"] or "not-on-cli": "<why>"`);
  }
  // (b) manifest flags against the CLI, and the CLI's flags against the manifest
  const named = new Map();
  // loop: NOT-WORTH — ~40 entries and their one or two flags
  for (const [f, v] of Object.entries(fields)) for (const fl of v.flags ?? []) named.set(fl, [...(named.get(fl) ?? []), f]);
  // loop: NOT-WORTH — ~40 flags
  for (const [fl, fs] of named) if (!cli.has(fl)) problems.push(`(b) ${M}: ${fl} (for ${fs.join(", ")}) isn't a render flag in cliSpec.json: ${NEW_FLAG}, or fix the entry`);
  // loop: NOT-WORTH — a dozen flags
  for (const fl of Object.keys(cliOnly)) {
    if (!cli.has(fl)) problems.push(`(d) ${M}: the cli-only ${fl} isn't a render flag in cliSpec.json any more: remove it`);
    if (named.has(fl)) problems.push(`(b) ${M}: ${fl} is both a field's flag and cli-only: keep one`);
  }
  // loop: NOT-WORTH — ~50 flags
  for (const fl of cli)
    if (!named.has(fl) && !(fl in cliOnly)) problems.push(`(b) corridorkey render ${fl} has no entry in ${M}: name the field it sets, or ${ADD} under "cli-only" with what it is for`);
  // loop: NOT-WORTH — ~35 pairs
  for (const [fl, f] of table) if (!(fields[f]?.flags ?? []).includes(fl)) problems.push(`(b) ck-cli args.rs maps ${fl} to \`${f}\`, but ${M} doesn't list ${fl} for \`${f}\`: fix the entry`);
  // (c) what the app sends: a flag, written by Copy as command, and farm export from the same table
  // loop: NOT-WORTH — ~20 fields
  for (const f of app) {
    const flags = fields[f]?.flags ?? [];
    if (!flags.length) {
      problems.push(`(c) the app sends \`${f}\` (queue.ts engineOptions) but the command line has no flag for it (${M}): ${NEW_FLAG}`);
      continue;
    }
    // loop: NOT-WORTH — one or two flags
    if (!flags.some((fl) => writer.has(fl)))
      problems.push(`(c) the app sends \`${f}\` but Copy as command doesn't write ${flags.join(" or ")}: add it to jobFlags in src/shared/console/jobCommand.ts (farm export takes it from there)`);
  }
  if (!/import \{[^}]*\bjobFlags\b[^}]*\} from "[^"]*jobCommand"/.test(farmTs) || !/\bjobFlags\(/.test(farmTs))
    problems.push("(c) electron/main/console/farm.ts doesn't take its flags from jobFlags (src/shared/console/jobCommand.ts): farm export must use Copy as command's table, not its own");
  return problems;
}

/** Everything, on this repository. */
export function checkAll(app = APP) {
  const read = (...p) => readFileSync(join(app, ...p), "utf8");
  return checkParity({
    manifest: JSON.parse(read("docs", "cli-parity.json")),
    engine: engineFields(read("engine-rs", "crates", "ck-core", "src", "job.rs")),
    spec: JSON.parse(read("src", "shared", "console", "cliSpec.json")),
    table: cliTable(read("engine-rs", "crates", "ck-cli", "src", "args.rs")),
    app: appFields(read("electron", "main", "queue.ts")),
    writer: writerFlags(read("src", "shared", "console", "jobCommand.ts")),
    farmTs: read("electron", "main", "console", "farm.ts"),
  });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const problems = checkAll();
  if (problems.length) {
    console.log('Command-line parity gate (docs/cli-parity.json, tools/check_cli_parity.mjs; docs/CLI.md "Adding an option"):\n' + problems.join("\n"));
    process.exit(1);
  }
}
