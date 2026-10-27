#!/usr/bin/env node
// Engine feature-set gate (audit row 11): what ships is what is linted and what the notices list. Source of truth:
// tools/build_engine.sh's builds (`--features X … --target T`, per release target). It fails when
//   (a) a shipped target has no `lint T FEATURES` line in tools/check_targets.sh, or that line lacks a shipped feature
//       (unless LINT_EXCEPTIONS says why), or lints a target nothing ships;
//   (b) tools/gen_notices.mjs's ENGINE_FEATURES isn't the union of the shipped features;
//   (c) engine-rs/about.toml's `targets` aren't the shipped targets.
//   node tools/check_features.mjs    the gate (npm run gates)
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const APP = join(dirname(fileURLToPath(import.meta.url)), "..");

// "<target> <feature>": a shipped feature the lint leaves out, and why
export const LINT_EXCEPTIONS = new Map([
  ["aarch64-apple-darwin ocio", "OCIO's C++ can't build for macOS on this PC (no Apple SDK): linted with ocio-rs's stub, the same Rust API; the macOS workflow builds the real one"],
]);

// loop: NOT-WORTH — a few comma-separated names
const list = (s) => s.split(",").filter(Boolean);

/** tools/build_engine.sh's release builds: [{ target, features }] (line continuations joined). */
export function shippedSets(sh) {
  // loop: NOT-WORTH — a few cargo builds
  return [...sh.replace(/\\\n\s*/g, " ").matchAll(/--features (\S+)\s+--target "?([\w-]+)/g)].map((m) => ({ target: m[2], features: list(m[1]) }));
}

/** tools/check_targets.sh's `lint TARGET FEATURES` lines. */
export function lintSets(sh) {
  // loop: NOT-WORTH — three lint lines
  return [...sh.matchAll(/^lint (\S+) (\S+)/gm)].map((m) => ({ target: m[1], features: list(m[2]) }));
}

export function checkFeatures(shipped, linted, noticesFeatures, aboutTargets, exceptions = LINT_EXCEPTIONS) {
  const out = [];
  // loop: NOT-WORTH — three targets
  for (const s of shipped) {
    // loop: NOT-WORTH — three lint lines
    const l = linted.find((x) => x.target === s.target);
    if (!l) {
      out.push(`tools/check_targets.sh: no lint line for ${s.target}, which tools/build_engine.sh ships (${s.features.join(",")})`);
      continue;
    }
    // loop: NOT-WORTH — a few features
    for (const f of s.features) if (!l.features.includes(f) && !exceptions.has(`${s.target} ${f}`)) out.push(`tools/check_targets.sh: ${s.target} is linted without "${f}", which it ships with`);
  }
  // loop: NOT-WORTH — three lint lines, against three targets
  for (const l of linted) if (!shipped.some((s) => s.target === l.target)) out.push(`tools/check_targets.sh: lints ${l.target}, which nothing ships`);
  // loop: NOT-WORTH — a few exceptions, against the shipped sets
  for (const k of exceptions.keys()) {
    const [t, f] = k.split(" ");
    // loop: NOT-WORTH — three targets
    const needed = shipped.some((s) => s.target === t && s.features.includes(f)) && !linted.some((l) => l.target === t && l.features.includes(f));
    if (!needed) out.push(`LINT_EXCEPTIONS lists "${k}", which isn't needed any more: remove it`);
  }
  // loop: NOT-WORTH — three targets' features
  const union = [...new Set(shipped.flatMap((s) => s.features))].sort();
  // loop: NOT-WORTH — a few feature names
  if (noticesFeatures.slice().sort().join(",") !== union.join(",")) out.push(`tools/gen_notices.mjs: ENGINE_FEATURES is ${noticesFeatures.join(",")}, the shipped features are ${union.join(",")}`);
  // loop: NOT-WORTH — three targets
  const targets = shipped.map((s) => s.target).sort();
  // loop: NOT-WORTH — three targets
  if (aboutTargets.slice().sort().join(",") !== targets.join(",")) out.push(`engine-rs/about.toml: targets are ${aboutTargets.join(", ")}, the shipped ones ${targets.join(", ")}`);
  return out;
}

export function checkAll(app = APP) {
  const read = (p) => readFileSync(join(app, p), "utf8");
  const shipped = shippedSets(read("tools/build_engine.sh"));
  if (!shipped.length) return ["check_features: found no `--features … --target …` build in tools/build_engine.sh (moved?)"];
  const notices = read("tools/gen_notices.mjs").match(/const ENGINE_FEATURES = "([^"]+)"/)?.[1] ?? "";
  const about = read("engine-rs/about.toml").match(/^targets = \[([^\]]*)\]/m)?.[1] ?? "";
  // loop: NOT-WORTH — three targets
  const aboutTargets = [...about.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  return checkFeatures(shipped, lintSets(read("tools/check_targets.sh")), list(notices), aboutTargets);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const problems = checkAll();
  if (problems.length) {
    console.log("Feature-set gate (tools/check_features.mjs):\n" + problems.join("\n"));
    process.exit(1);
  }
}
