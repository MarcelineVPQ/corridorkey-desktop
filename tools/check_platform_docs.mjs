#!/usr/bin/env node
// Per-OS docs gate (audit row 8): every system the app is packaged for has its install page and its uninstall steps
// in the wiki. Source of truth: electron-builder.yml's top-level `linux:` / `win:` / `mac:` blocks. It fails when
//   (a) docs/wiki/Installing-on-<System>.md is missing;
//   (b) docs/wiki/Uninstall.md has no `## <System>` section, or its table's header has no <System> column;
// unless EXCEPTIONS lists that page ("Installing-on-<System>.md") or section ("Uninstall.md#<System>") with why; an
// entry no longer needed fails too.
//   node tools/check_platform_docs.mjs    the gate (npm run gates)
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
const NAMES = { linux: "Linux", win: "Windows", mac: "macOS" };

// What a system may lack for now, and why ("<page>" or "Uninstall.md#<System>").
export const EXCEPTIONS = new Map([["Installing-on-macOS.md", "for Marcy (2026-10-27): 1.0.0-dev.1 ships no macOS build (README, 'macOS, honestly'); the page's content waits for the Mac release"]]);

/** The systems electron-builder.yml packages for, by their names in the docs. */
export function packagedSystems(yml) {
  // loop: NOT-WORTH — three top-level keys
  return [...yml.matchAll(/^(linux|win|mac):/gm)].map((m) => NAMES[m[1]]);
}

/** (b): what Uninstall.md lacks for one system. */
export function uninstallProblems(system, un) {
  // loop: NOT-WORTH — the page's lines, once per system
  const header = un.split("\n").find((l) => l.startsWith("| What |")) ?? "";
  const out = [];
  if (!new RegExp(`^## ${system}\\s*$`, "m").test(un)) out.push(`docs/wiki/Uninstall.md has no "## ${system}" section`);
  if (!header.includes(`| ${system} `)) out.push(`docs/wiki/Uninstall.md's table has no ${system} column`);
  return out;
}

/** (a) and (b) for the packaged systems; `wiki` maps page file names to their text. */
export function checkSystems(systems, wiki, exceptions = EXCEPTIONS) {
  const out = [];
  const used = new Set();
  // loop: NOT-WORTH — three systems
  for (const system of systems) {
    const install = `Installing-on-${system}.md`;
    if (exceptions.has(install)) used.add(install);
    else if (!(install in wiki)) out.push(`docs/wiki/${install} is missing (packaged for ${system})`);
    if (install in wiki && exceptions.has(install)) out.push(`EXCEPTIONS lists "${install}", which exists now: remove it`);
    const un = uninstallProblems(system, wiki["Uninstall.md"] ?? "");
    const key = `Uninstall.md#${system}`;
    if (exceptions.has(key)) {
      used.add(key);
      if (!un.length) out.push(`EXCEPTIONS lists "${key}", which is there now: remove it`);
    } else out.push(...un);
  }
  // loop: NOT-WORTH — a few exceptions
  for (const what of exceptions.keys()) if (!used.has(what)) out.push(`EXCEPTIONS lists "${what}", for no packaged system: remove it`);
  return out;
}

export function checkAll(app = APP) {
  const systems = packagedSystems(readFileSync(join(app, "electron-builder.yml"), "utf8"));
  const wiki = {};
  // loop: NOT-WORTH — a page per system plus Uninstall.md
  for (const f of ["Uninstall.md", ...systems.map((s) => `Installing-on-${s}.md`)]) {
    const p = join(app, "docs/wiki", f);
    if (existsSync(p)) wiki[f] = readFileSync(p, "utf8");
  }
  return checkSystems(systems, wiki);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const problems = checkAll();
  if (problems.length) {
    console.log("Per-OS docs gate (docs/wiki/, tools/check_platform_docs.mjs):\n" + problems.join("\n"));
    process.exit(1);
  }
}
