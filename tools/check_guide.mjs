#!/usr/bin/env node
// Guide gate (audit row 7): every panel section of the app has its place in docs/GUIDE.md. Source of truth: the
// `<Section … title="…">` literals in src/ui (a computed title, as the About page's chapters, isn't one). It fails
// when a section's title is neither the start of a GUIDE.md heading (`## Hints` covers "Hint") nor a whole phrase
// inside a **bold** one there (`**App settings → Console**` covers "Console"), case-insensitive.
//   node tools/check_guide.mjs    the gate (npm run gates)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const APP = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The literal section titles of one .tsx source. */
export function sectionTitles(tsx) {
  // loop: NOT-WORTH — a few sections per file
  return [...tsx.matchAll(/<Section\b[^>]*?\btitle="([^"]+)"/g)].map((m) => m[1]);
}

/** Whether GUIDE.md has a heading starting with the title, or a bold phrase holding it as whole words. */
export function inGuide(guide, title) {
  const t = title.toLowerCase();
  const low = guide.toLowerCase();
  const word = new RegExp(`(^|\\W)${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\W|$)`);
  // loop: NOT-WORTH — the guide's headings, once per title
  if ([...low.matchAll(/^#+\s+(.+)$/gm)].some((m) => m[1].startsWith(t))) return true;
  // loop: NOT-WORTH — the guide's bold phrases, once per title
  return [...low.matchAll(/\*\*([^*]+)\*\*/g)].some((m) => word.test(m[1]));
}

export function checkAll(app = APP) {
  const guide = readFileSync(join(app, "docs/GUIDE.md"), "utf8");
  const out = [];
  const walk = (d) => {
    // loop: NOT-WORTH — src/ui's entries, once per gate run
    for (const n of readdirSync(join(app, d))) {
      const p = join(d, n);
      if (statSync(join(app, p)).isDirectory()) walk(p);
      else if (p.endsWith(".tsx")) {
        // loop: NOT-WORTH — a few sections per file
        for (const t of sectionTitles(readFileSync(join(app, p), "utf8"))) {
          if (!inGuide(guide, t)) out.push(`${p}: section "${t}" has no heading or **bold** mention in docs/GUIDE.md`);
        }
      }
    }
  };
  walk("src/ui");
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const problems = checkAll();
  if (problems.length) {
    console.log("Guide gate (docs/GUIDE.md, tools/check_guide.mjs):\n" + problems.join("\n"));
    process.exit(1);
  }
}
