#!/usr/bin/env node
// npm run gates: runs every gate (each one, even after a failure, so one run shows them all), prints each result,
// and exits 1 when any failed.
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
