#!/usr/bin/env node
// Provider gate (audit row 5): the engine's provider and device names reach every place that lists them.
// Sources of truth: ck-core's `Provider::name()` (runtime.rs) and `Device::name()` (config.rs), plus the combined
// provider the keying stage sends ("tensorrt+cuda", pipeline/keying.rs). It fails when
//   (a) src/ui/format.ts providerName() has no screen name for a provider;
//   (b) docs/ENGINE_PROTOCOL.md's `"provider":"a|b|…"` line misses a provider;
//   (c) a device list in the docs (`auto|cuda|…`, `auto | cuda | …`: starts with auto, has cuda) misses a device;
//   (d) the bug form's Engine dropdown (.github/ISSUE_TEMPLATE/bug_report.yml) has no option naming a single
//       provider's screen name.
//   node tools/check_providers.mjs    the gate (npm run gates)
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const APP = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The names a Rust `fn name(&self)` returns for `enum` (`Enum::Variant => "name"`). */
export function enumNames(rs, enumName) {
  const re = new RegExp(`${enumName}::\\w+ => "([^"]+)"`, "g");
  // loop: NOT-WORTH — a handful of match arms
  return [...rs.matchAll(re)].map((m) => m[1]);
}

/** The combined provider names a source sends ("tensorrt+cuda"). */
export function comboNames(rs) {
  // loop: NOT-WORTH — a few literals in one file
  return [...new Set([...rs.matchAll(/"([a-z]+\+[a-z]+)"/g)].map((m) => m[1]))];
}

/** The keys of format.ts's providerName() map. */
export function screenNames(formatTs) {
  const map = formatTs.match(/names: Record<string, string> = \{([^}]*)\}/);
  if (!map) return {};
  // loop: NOT-WORTH — a handful of entries
  return Object.fromEntries([...map[1].matchAll(/"?([\w+]+)"?: "([^"]+)"/g)].map((m) => [m[1], m[2]]));
}

export function checkFormat(formatTs, providers) {
  const names = screenNames(formatTs);
  // loop: NOT-WORTH — a handful of providers
  return providers.filter((p) => !names[p]).map((p) => `src/ui/format.ts: providerName() has no screen name for "${p}"`);
}

export function checkProtocol(doc, providers) {
  const line = doc.match(/"type":"provider".*?"provider":"([^"]+)"/);
  if (!line) return [`docs/ENGINE_PROTOCOL.md: no "provider" reply example`];
  const listed = line[1].split("|");
  // loop: NOT-WORTH — a handful of providers
  return providers.filter((p) => !listed.includes(p)).map((p) => `docs/ENGINE_PROTOCOL.md: the provider reply's list misses "${p}"`);
}

/** Every device list (`auto|cuda|cpu`, `auto | cuda | cpu`, markdown-escaped `\|`) in a doc that misses a device. */
export function checkDeviceLists(file, text, devices) {
  const out = [];
  // loop: NOT-WORTH — one doc's lines, once per gate run
  text.split("\n").forEach((l, i) => {
    // loop: NOT-WORTH — a few lists per line
    for (const m of l.matchAll(/\bauto(\s*\\?\|\s*[a-z][\w-]*)+/g)) {
      const listed = m[0].split(/\s*\\?\|\s*/);
      if (!listed.includes("cuda")) continue; // another knob's auto | … list
      // loop: NOT-WORTH — a handful of devices
      const missing = devices.filter((d) => !listed.includes(d));
      if (missing.length) out.push(`${file}:${i + 1}: device list "${m[0]}" misses ${missing.join(", ")}`);
    }
  });
  return out;
}

/** The bug form's Engine dropdown must name every single provider the way the app shows it. */
export function checkBugForm(yml, names, providers) {
  const block = yml.match(/id: engine\n[\s\S]*?options:\n((?:\s+- .*\n?)+)/);
  if (!block) return [".github/ISSUE_TEMPLATE/bug_report.yml: no Engine dropdown (id: engine)"];
  // loop: NOT-WORTH — a handful of providers
  return providers
    .filter((p) => !p.includes("+") && names[p] && !block[1].includes(names[p]))
    .map((p) => `.github/ISSUE_TEMPLATE/bug_report.yml: the Engine dropdown has no option for ${names[p]} ("${p}")`);
}

/** The markdown files of the docs that list devices: docs/ (with the wiki), README.md. */
function docFiles(app) {
  const out = [];
  const walk = (d) => {
    // loop: NOT-WORTH — the docs folder's entries, once per gate run
    for (const n of readdirSync(join(app, d))) {
      const p = join(d, n);
      if (statSync(join(app, p)).isDirectory()) walk(p);
      else if (p.endsWith(".md")) out.push(p);
    }
  };
  walk("docs");
  if (existsSync(join(app, "README.md"))) out.push("README.md");
  return out;
}

export function checkAll(app = APP) {
  const read = (p) => readFileSync(join(app, p), "utf8");
  const core = "engine-rs/crates/ck-core/src";
  const providers = [...enumNames(read(`${core}/runtime.rs`), "Provider"), ...comboNames(read(`${core}/pipeline/keying.rs`))];
  const devices = enumNames(read(`${core}/config.rs`), "Device");
  if (!providers.length || !devices.length) return ["check_providers: found no Provider/Device names in ck-core (moved?)"];
  const formatTs = read("src/ui/format.ts");
  return [
    ...checkFormat(formatTs, providers),
    ...checkProtocol(read("docs/ENGINE_PROTOCOL.md"), providers),
    // loop: NOT-WORTH — the docs' markdown files, once per gate run
    ...docFiles(app).flatMap((f) => checkDeviceLists(f, read(f), devices)),
    ...checkBugForm(read(".github/ISSUE_TEMPLATE/bug_report.yml"), screenNames(formatTs), providers),
  ];
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const problems = checkAll();
  if (problems.length) {
    console.log("Provider gate (tools/check_providers.mjs):\n" + problems.join("\n"));
    process.exit(1);
  }
}
