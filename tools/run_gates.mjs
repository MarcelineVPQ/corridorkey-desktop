#!/usr/bin/env node
// npm run gates: runs every gate (each one, even after a failure, so one run shows them all), prints each result,
// and exits 1 when any failed. POSIX only (Linux, where the releases are built, and macOS CI): the security gate is
// bash, and the gates compare repository paths with `/`; Windows CI runs only the engine's checks (windows.yml).
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const GATES = [
  ["Electron security", "bash", [".hooks/check_electron_security.sh"]],
  ["theme colors", "node", [".hooks/check_theme_colors.mjs"]],
  ["loop pass", "node", ["tools/list_loops.mjs", "--check"]],
  ["no folds", "node", ["tools/check_no_folds.mjs"]],
  ["wiki", "node", ["tools/check_wiki.mjs"]],
  ["CLI parity", "node", ["tools/check_cli_parity.mjs"]],
  ["IPC sender", "node", ["tools/check_ipc_sender.mjs"]],
  ["notices (downloads)", "node", ["tools/check_notices_downloads.mjs"]],
  ["providers", "node", ["tools/check_providers.mjs"]],
  ["protocol doc", "node", ["tools/check_protocol_doc.mjs"]],
  ["guide", "node", ["tools/check_guide.mjs"]],
  ["docs touch", "node", ["tools/check_docs_touch.mjs"]],
  ["per-OS docs", "node", ["tools/check_platform_docs.mjs"]],
  ["backlog", "node", ["tools/check_backlog.mjs"]],
  ["engine features", "node", ["tools/check_features.mjs"]],
  ["farm submitters", "node", ["tools/check_farm_submitters.mjs"]],
  ["shared texts", "node", ["tools/check_texts.mjs"]],
  ["README what's coming", "node", ["tools/check_readme_coming.mjs"]],
  ["engine knobs", "node", ["tools/check_knobs.mjs"]],
  ["platform tests", "node", ["tools/check_platform_tests.mjs"]],
  ["test files", "node", ["tools/check_test_files.mjs"]],
  ["rail tips", "node", ["tools/check_rail_tips.mjs"]],
];

const repo = fileURLToPath(new URL("..", import.meta.url));
const failed = [];
// loop: SERIAL-REQUIRED — one gate at a time, so their outputs don't interleave [bounded: 5 min each]
for (const [name, cmd, args] of GATES) {
  // loop: SERIAL-REQUIRED — one gate's run, 5 min deadline
  const r = spawnSync(cmd === "node" ? process.execPath : cmd, args, { cwd: repo, stdio: "inherit", timeout: 300_000 });
  const ok = r.status === 0;
  console.log(`gate ${ok ? "ok    " : "FAILED"} ${name}${r.error ? ` (${r.error.message})` : ""}`);
  if (!ok) failed.push(name);
}
if (failed.length) {
  console.log(`gates: ${failed.length} of ${GATES.length} failed: ${failed.join(", ")}`);
  process.exit(1);
}
