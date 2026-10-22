#!/usr/bin/env node
// Gate (the DS5 page rule): nothing folds inside a page. Readouts are
// MainBlocks (always shown); only panel Sections open and close. No
// <details>/<summary> anywhere in src/.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
const hits = [];
const walk = (d) => {
  // loop: NOT-WORTH — the source folders' entries, once per gate run
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.tsx?$/.test(p))
      readFileSync(p, "utf8")
        .split("\n")
        // loop: NOT-WORTH — one file's lines, once per gate run
        .forEach((l, i) => /<(details|summary)[\s>]/.test(l) && hits.push(`${p}:${i + 1}: ${l.trim()}`));
  }
};
walk("src");
if (hits.length) {
  console.log("No-folds gate: use a MainBlock (readouts) or a panel Section (settings):\n" + hits.join("\n"));
  process.exit(1);
}
