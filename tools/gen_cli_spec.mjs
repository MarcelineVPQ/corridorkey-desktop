#!/usr/bin/env node
// The Console's copy of the `corridorkey` command line (backlog row 95): src/shared/console/cliSpec.json, what
// `corridorkey __spec --json` prints (docs/CLI.md "For tools"), minus its `version` (the app knows its own; a version
// bump must not make the copy stale). Run by the build (package.json) so the Console's completion, hints and checks
// are the CLI's own flags; checked in so a build without the engine still has them, and tests/unit/cliSpec.test.ts
// fails when the copy and the binary differ.
//
//   node tools/gen_cli_spec.mjs   write the copy from the built binary (none built: the checked-in copy stays, said so)
//
// The binary: CK_CLI_BIN, else the newest of engine-rs/target/{dist,release,debug}/corridorkey that runs here (dist can
// hold another system's build after a cross-build: it is skipped).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SPEC_FILE = join(APP, "src", "shared", "console", "cliSpec.json");

/** The host's corridorkey binaries, newest first (CK_CLI_BIN alone when set). */
export function findCliBins(env = process.env) {
  if (env.CK_CLI_BIN) return existsSync(env.CK_CLI_BIN) ? [env.CK_CLI_BIN] : [];
  const exe = process.platform === "win32" ? "corridorkey.exe" : "corridorkey";
  // loop: NOT-WORTH — three candidate folders, once per build
  const found = ["dist", "release", "debug"].map((d) => join(APP, "engine-rs", "target", d, exe)).filter((p) => existsSync(p));
  // loop: NOT-WORTH — sorts at most three paths by age, once per build
  // loop: NOT-WORTH — one stat per candidate (sync: a build tool, not the app)
  return found.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

/** The first binary that answers, with its spec; null when none does. */
export function hostSpec(env = process.env) {
  // loop: NOT-WORTH — at most three candidates, once per build
  for (const bin of findCliBins(env)) {
    try {
      return { bin, spec: readSpec(bin) };
    } catch {
      // error: SHOWN — another system's build (or a broken one): the next candidate, else the message below
    }
  }
  return null;
}

/** The binary's description of itself, without its version. */
export function readSpec(bin) {
  // loop: NOT-WORTH — one short run of the binary per build [bounded: 30 s]
  const out = execFileSync(bin, ["__spec", "--json"], { encoding: "utf8", timeout: 30_000, windowsHide: true });
  const { version: _version, ...spec } = JSON.parse(out);
  return spec;
}

export const specText = (spec) => JSON.stringify(spec, null, 2) + "\n";

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const found = hostSpec();
  if (!found) {
    console.log(`gen_cli_spec: no corridorkey binary built for this system; kept ${SPEC_FILE}`);
  } else {
    const { bin } = found;
    const text = specText(found.spec);
    // loop: NOT-WORTH — reads one small JSON file (sync: a build tool)
    const old = existsSync(SPEC_FILE) ? readFileSync(SPEC_FILE, "utf8") : "";
    if (old === text) console.log(`gen_cli_spec: ${SPEC_FILE} is current (${bin})`);
    else {
      // loop: NOT-WORTH — writes one small JSON file (sync: a build tool)
      writeFileSync(SPEC_FILE, text);
      console.log(`gen_cli_spec: wrote ${SPEC_FILE} from ${bin}`);
    }
  }
}
