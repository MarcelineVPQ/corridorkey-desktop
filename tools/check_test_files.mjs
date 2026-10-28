#!/usr/bin/env node
// Test-file gate (audit row 19): every main-process module has unit tests. Sources of truth: electron/main/**.ts and
// the imports of tests/unit/*.ts. A module is tested when a unit test imports it, or when a module a unit test imports
// (other than index.ts) imports it (help.ts through the Console runner's tests). It fails on a module that is neither,
// unless UNTESTED says why; an entry that is tested now, or whose module is gone, fails too.
//   node tools/check_test_files.mjs    the gate (npm run gates)
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const APP = join(dirname(fileURLToPath(import.meta.url)), "..");

// Modules without unit tests of their own, and why
export const UNTESTED = new Map([
  ["electron/main/index", "the Electron wiring (windows, menus, IPC handlers): its parts are tested in their modules, the whole in tools/isolated.sh runs"],
  ["electron/main/boot", "the entry's few lines of Electron (app.exit, dock, sessionData) around headlessFlag.ts, which is tested (consoleHeadless.test.ts)"],
  ["electron/main/ipc", "the IPC channel names, one constant object"],
  ["electron/main/updater", "Electron's net and app around updateFlow.ts (updateFlow.test.ts); end to end in tools/update_e2e.sh"],
  ["electron/main/desktopTheme", "reads the desktop's colours through Electron (nativeTheme, systemPreferences) and KDE's files; their parsing is palette.ts (palette.test.ts)"],
]);

/** The modules a source imports (relative import statements, not ones quoted in a fixture string; resolved against
 * its own path, without extension). */
export function importsOf(path, src) {
  // loop: NOT-WORTH — one file's imports
  return [...src.matchAll(/^\s*(?:import|export)\b[^;'"`]*?from "(\.{1,2}\/[^"]+)"/gm)].map((m) => normalize(join(dirname(path), m[1])).replace(/\.tsx?$/, ""));
}

/** `modules`: { path (no extension): source }; `tests`: { path: source }. */
export function checkModules(modules, tests, untested = UNTESTED) {
  const direct = new Set();
  // loop: NOT-WORTH — the unit tests, once per gate run
  for (const [p, src] of Object.entries(tests)) for (const m of importsOf(p, src)) direct.add(m);
  const covered = new Set(direct);
  // loop: NOT-WORTH — the tested modules' imports
  for (const m of direct) if (modules[m] !== undefined && !m.endsWith("/index")) for (const i of importsOf(`${m}.ts`, modules[m])) covered.add(i);
  const out = [];
  // loop: NOT-WORTH — the main process's modules
  for (const m of Object.keys(modules).sort()) {
    if (covered.has(m) && untested.has(m)) out.push(`UNTESTED lists ${m}, which is tested now: remove it`);
    else if (!covered.has(m) && !untested.has(m)) out.push(`${m}.ts has no unit test (no test imports it, nor a tested module): write one, or add it to UNTESTED with why`);
  }
  // loop: NOT-WORTH — a few entries
  for (const m of untested.keys()) if (modules[m] === undefined) out.push(`UNTESTED lists ${m}, which doesn't exist any more: remove it`);
  return out;
}

export function checkAll(app = APP) {
  const modules = {};
  const walk = (d) => {
    // loop: NOT-WORTH — electron/main's entries, once per gate run
    for (const n of readdirSync(join(app, d))) {
      const p = join(d, n);
      if (statSync(join(app, p)).isDirectory()) walk(p);
      else if (n.endsWith(".ts") && !n.endsWith(".d.ts")) modules[p.slice(0, -3)] = readFileSync(join(app, p), "utf8");
    }
  };
  walk("electron/main");
  const tests = {};
  const dir = join(app, "tests/unit");
  // loop: NOT-WORTH — the unit tests, once per gate run
  for (const n of existsSync(dir) ? readdirSync(dir) : []) if (n.endsWith(".ts")) tests[`tests/unit/${n}`] = readFileSync(join(dir, n), "utf8");
  return checkModules(modules, tests);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const problems = checkAll();
  if (problems.length) {
    console.log("Test-file gate (tools/check_test_files.mjs):\n" + problems.join("\n"));
    process.exit(1);
  }
}
