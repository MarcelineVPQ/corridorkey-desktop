#!/usr/bin/env node
// Gate (offline): every first-run download electron/main/install.ts pins is named in THIRD_PARTY_NOTICES.md: each
// model set as `<set>`, each wheel as its row `| <project> | <version> |` (tools/install_pins.mjs reads the pins).
// tools/gen_notices.mjs writes the file; its full --check needs cargo-about and runs at release, this runs every time.
//
//   node tools/check_notices_downloads.mjs [root]    root: the tree to check (tests use fixtures); default the repo
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { modelSets, wheels } from "./install_pins.mjs";

const root = process.argv[2] ?? fileURLToPath(new URL("..", import.meta.url));
const src = readFileSync(join(root, "electron/main/install.ts"), "utf8");
const notices = readFileSync(join(root, "THIRD_PARTY_NOTICES.md"), "utf8");
const missing = [
  // loop: NOT-WORTH — the two or three sets
  ...modelSets(src)
    .filter((s) => !notices.includes(`\`${s}\``))
    .map((s) => `model set ${s}`),
  // loop: NOT-WORTH — ~15 wheels
  ...wheels(src)
    .map((w) => [w.name.replace(/_/g, "-"), w.version])
    .filter(([p, v]) => !notices.includes(`| ${p} | ${v} |`))
    .map(([p, v]) => `wheel ${p} ${v}`),
];
if (missing.length) {
  console.log("Notices gate: THIRD_PARTY_NOTICES.md doesn't name these downloads; run node tools/gen_notices.mjs:\n" + missing.join("\n"));
  process.exit(1);
}
