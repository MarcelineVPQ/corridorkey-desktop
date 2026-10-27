#!/usr/bin/env node
// Platform-test gate (audit row 18): a module that branches on the operating system is tested on each system it
// branches on. Sources of truth: the code (comments left out) of electron/main/** and src/shared/** and the unit tests
// in tests/unit/ that import each module. A module branches on win32 / darwin / linux when its code has that quoted
// name ("win32") or calls isWin( / isMac( / isLinux(. It fails when the tests importing such a module never name one of
// its systems as a quoted string in their code (a test that runs it as that system passes "darwin" somewhere). A
// module no test imports is the test-file gate's business (tools/check_test_files.mjs), not this one's. EXCEPTIONS
// carries a branch no test can take, with why.
//   node tools/check_platform_tests.mjs    the gate (npm run gates)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
// "<module> <system>": a branch its tests can't take, and why
export const EXCEPTIONS = new Map([
  ["electron/main/appImageQuit linux", "holdAppImageMountUntilExit acts only in a Linux AppImage as it quits (a detached /bin/sh helper); its pure parts are tested"],
]);
const SYSTEMS = { win32: /"win32"|\bisWin\(/, darwin: /"darwin"|\bisMac\(/, linux: /"linux"|\bisLinux\(/ };

/** A source without its comments (line comments not inside a URL or a string's start, block comments). */
export function codeOnly(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\w"'`])\/\/.*$/gm, "$1");
}

/** The systems a module's code branches on. */
export function branchesOn(code) {
  // loop: NOT-WORTH — three systems
  return Object.keys(SYSTEMS).filter((s) => SYSTEMS[s].test(code));
}

/** `module`: its path without the extension (electron/main/queue); `tests`: [{ path, code }]. */
export function checkModule(module, code, tests, exceptions = EXCEPTIONS) {
  const systems = branchesOn(code);
  if (!systems.length) return [];
  const imports = new RegExp(`^\\s*import\\b[^;'"\`]*?from "(\\.\\./)+${module.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`, "m");
  // loop: NOT-WORTH — the unit tests, once per module that branches
  const mine = tests.filter((t) => imports.test(t.code));
  if (!mine.length) return [];
  const out = [];
  // loop: NOT-WORTH — three systems, against a few tests
  for (const s of systems) {
    // loop: NOT-WORTH — a few tests
    const run = mine.some((t) => t.code.includes(`"${s}"`));
    if (exceptions.has(`${module} ${s}`)) {
      if (run) out.push(`EXCEPTIONS lists "${module} ${s}", which its tests run now: remove it`);
    } else if (!run) {
      // loop: NOT-WORTH — a few test names in the message
      out.push(`${module}.ts branches on ${s}, but its tests (${mine.map((t) => t.path).join(", ")}) never run it as "${s}"`);
    }
  }
  return out;
}

export function checkAll(app = APP) {
  const testDir = join(app, "tests/unit");
  // loop: NOT-WORTH — the unit tests, once per gate run
  const tests = readdirSync(testDir)
    .filter((n) => n.endsWith(".ts"))
    .map((n) => ({ path: `tests/unit/${n}`, code: codeOnly(readFileSync(join(testDir, n), "utf8")) }));
  const out = [];
  const walk = (d) => {
    // loop: NOT-WORTH — the source folders' entries, once per gate run
    for (const n of readdirSync(join(app, d))) {
      const p = join(d, n);
      if (statSync(join(app, p)).isDirectory()) walk(p);
      else if (n.endsWith(".ts") && !n.endsWith(".d.ts")) out.push(...checkModule(p.slice(0, -3), codeOnly(readFileSync(join(app, p), "utf8")), tests));
    }
  };
  walk("electron/main");
  walk("src/shared");
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const problems = checkAll();
  if (problems.length) {
    console.log("Platform-test gate (tools/check_platform_tests.mjs):\n" + problems.join("\n"));
    process.exit(1);
  }
}
