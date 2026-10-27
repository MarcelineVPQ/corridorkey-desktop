#!/usr/bin/env node
// Rail tooltip gate (audit row 21): a rail item's tooltip says what its page holds. Sources of truth: the rail's
// items (src/ui/rail/railModel.ts ITEMS: id, tip) and each page's panel sections (the `<Section title="…">` literals
// in src/ui/pages/<Id>Page.tsx). It fails when a page's section isn't in its tip (the title's first word, as a word,
// case-insensitive: "Graphics memory" needs "graphics"), unless TIP_SUMMARIES says why that tip sums the page up
// instead; a page with no literal sections in its file (the Queue's are the clip's, in JobSettings.tsx; About's are
// the docs) has nothing to check.
//   node tools/check_rail_tips.mjs    the gate (npm run gates)
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const APP = join(dirname(fileURLToPath(import.meta.url)), "..");

// pages whose tip sums the page up instead of naming its sections, and why
export const TIP_SUMMARIES = new Map([["console", "the tip says what the Console is (its own commands, never a system shell); its sections are its session, history, keys and settings"]]);

/** railModel.ts's items: [{ id, tip }]. */
export function railItems(ts) {
  // loop: NOT-WORTH — five rail items
  return [...ts.matchAll(/\{ id: "(\w+)", label: "[^"]*", tip: "([^"]*)" \}/g)].map((m) => ({ id: m[1], tip: m[2] }));
}

/** The literal section titles of a page source. */
export function sectionTitles(tsx) {
  // loop: NOT-WORTH — a few sections per page
  return [...tsx.matchAll(/<Section\b[^>]*?\btitle="([^"]+)"/g)].map((m) => m[1]);
}

/** The sections a tip doesn't name (by their first word). */
export function missingFromTip(tip, titles) {
  const low = tip.toLowerCase();
  // loop: NOT-WORTH — a few sections
  return titles.filter((t) => !new RegExp(`\\b${t.toLowerCase().split(/\s+/)[0].replace(/[^\w]/g, "")}`).test(low));
}

export function checkAll(app = APP) {
  const items = railItems(readFileSync(join(app, "src/ui/rail/railModel.ts"), "utf8"));
  if (!items.length) return ["check_rail_tips: found no rail items in src/ui/rail/railModel.ts (moved?)"];
  const out = [];
  // loop: NOT-WORTH — five rail items
  for (const { id, tip } of items) {
    const file = `src/ui/pages/${id.charAt(0).toUpperCase()}${id.slice(1)}Page.tsx`;
    if (!existsSync(join(app, file))) {
      out.push(`rail item "${id}": no ${file}`);
      continue;
    }
    const missing = missingFromTip(tip, sectionTitles(readFileSync(join(app, file), "utf8")));
    if (TIP_SUMMARIES.has(id)) {
      if (!missing.length) out.push(`TIP_SUMMARIES lists "${id}", whose tip names every section now: remove it`);
    } else if (missing.length) out.push(`src/ui/rail/railModel.ts: the "${id}" tip ("${tip}") doesn't name ${missing.join(", ")} (${file})`);
  }
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const problems = checkAll();
  if (problems.length) {
    console.log("Rail tooltip gate (tools/check_rail_tips.mjs):\n" + problems.join("\n"));
    process.exit(1);
  }
}
