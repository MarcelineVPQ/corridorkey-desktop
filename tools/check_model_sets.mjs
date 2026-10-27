#!/usr/bin/env node
// Model-set gate (audit row 9; ONLINE, so tools/release.sh runs it, not `npm run gates`): every model set the app
// pins is on GitHub as it is pinned, with its licence files. Sources of truth: electron/main/install.ts (each
// `const X_SET`, each `inRelease(SET)` helper and its `(file, size, sha256)` pins), updateFeed.ts's REPO, and the
// releases `models-<set>` on GitHub. It fails when
//   (a) a pinned file is missing from its release, or its size or SHA-256 (GitHub's digest) differs from the pin;
//   (b) the base set's release (the set the others are named after) lacks LICENSE, NOTICE or ATTRIBUTION.md;
//   (c) a derived set's release (…-trt, …-coreml) lacks one of the base release's licence files
//       (LICENSE*, NOTICE, ATTRIBUTION*), or has it at another size.
//   GITHUB_TOKEN="$(gh auth token)" node tools/check_model_sets.mjs    (release.sh; the token only lifts the rate limit)
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
const LICENCE = /^(LICENSE|NOTICE|ATTRIBUTION)/;

/** install.ts's model sets: [{ set, base, files: [{ file, size, sha256 }] }] (base: the set it derives from, or null). */
export function pinnedSets(installTs) {
  const names = {};
  const base = {};
  // loop: NOT-WORTH — a few set constants
  for (const m of installTs.matchAll(/^const (\w+_SET) = "([^"]+)";/gm)) names[m[1]] = m[2];
  // loop: NOT-WORTH — a few derived set constants
  for (const m of installTs.matchAll(/^const (\w+_SET) = `\$\{(\w+)\}([^`]+)`;/gm)) {
    names[m[1]] = names[m[2]] + m[3];
    base[names[m[1]]] = names[m[2]];
  }
  // a derived set named as a literal ("2.0.0-onnx.4-trt") derives from the set its name extends
  // loop: NOT-WORTH — a few sets, against each other
  for (const n of Object.values(names)) base[n] ??= Object.values(names).find((b) => b !== n && n.startsWith(`${b}-`)) ?? null;
  const sets = [];
  // loop: NOT-WORTH — a few inRelease helpers
  for (const h of installTs.matchAll(/^const (\w+) = inRelease\((\w+)\);/gm)) {
    const set = names[h[2]];
    // loop: NOT-WORTH — one set's dozen pins
    const files = [...installTs.matchAll(new RegExp(`\\b${h[1]}\\("([^"]+)", (\\d+), "([0-9a-f]{64})"\\)`, "g"))].map((m) => ({ file: m[1], size: Number(m[2]), sha256: m[3] }));
    sets.push({ set, base: base[set], files });
  }
  return sets;
}

/** (a)–(c) for one set; `assets` are GitHub's [{ name, size, digest }] for it, `baseAssets` its base set's (or null). */
export function checkRelease(s, assets, baseAssets) {
  const out = [];
  const tag = `models-${s.set}`;
  // loop: NOT-WORTH — one release's assets
  const by = new Map(assets.map((a) => [a.name, a]));
  // loop: NOT-WORTH — one set's pins
  for (const p of s.files) {
    const a = by.get(p.file);
    if (!a) out.push(`${tag}: ${p.file} is pinned in install.ts but not in the release`);
    else if (a.size !== p.size) out.push(`${tag}: ${p.file} is ${a.size} bytes, pinned ${p.size}`);
    else if (a.digest && a.digest !== `sha256:${p.sha256}`) out.push(`${tag}: ${p.file}'s SHA-256 (${a.digest}) isn't the pin's`);
  }
  if (!s.base) {
    // loop: NOT-WORTH — three names
    for (const f of ["LICENSE", "NOTICE", "ATTRIBUTION.md"]) if (!by.has(f)) out.push(`${tag}: no ${f}`);
  } else {
    // loop: NOT-WORTH — the base release's few licence files
    for (const l of (baseAssets ?? []).filter((a) => LICENCE.test(a.name))) {
      const a = by.get(l.name);
      if (!a) out.push(`${tag}: no ${l.name} (models-${s.base} has it)`);
      else if (a.size !== l.size) out.push(`${tag}: ${l.name} is ${a.size} bytes, models-${s.base}'s ${l.size}`);
    }
  }
  return out;
}

export async function checkAll(app = APP) {
  const sets = pinnedSets(readFileSync(join(app, "electron/main/install.ts"), "utf8"));
  const repo = readFileSync(join(app, "electron/main/updateFeed.ts"), "utf8").match(/export const REPO = "([^"]+)"/)?.[1];
  if (!sets.length || !repo) return ["check_model_sets: found no model sets in install.ts or no REPO in updateFeed.ts (moved?)"];
  const headers = { Accept: "application/vnd.github+json", ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) };
  const assets = {};
  // loop: SERIAL-REQUIRED — one GitHub API call per set, three sets [bounded: 30 s each]
  for (const s of sets) {
    // loop: SERIAL-REQUIRED — the set's release, one call [bounded: 30 s]
    const r = await fetch(`https://api.github.com/repos/${repo}/releases/tags/models-${s.set}`, { headers, signal: AbortSignal.timeout(30_000) });
    if (!r.ok) return [`models-${s.set}: GitHub answered ${r.status} for the release`];
    assets[s.set] = (await r.json()).assets;
  }
  // loop: NOT-WORTH — three sets
  return sets.flatMap((s) => checkRelease(s, assets[s.set], s.base ? (assets[s.base] ?? null) : null));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const problems = await checkAll();
  if (problems.length) {
    console.log("Model-set gate (GitHub releases models-*, tools/check_model_sets.mjs):\n" + problems.join("\n"));
    process.exit(1);
  }
  console.log("check_model_sets: every pinned model set is on GitHub as pinned, with its licence files");
}
