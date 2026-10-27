#!/usr/bin/env node
// Gate: every IPC handler in electron/ checks who sent the message. Each ipcMain (or webContents.ipc)
// handle / handleOnce / on / once / addListener call passes its handler through fromAppPageOnly (validate.ts) on
// the same line or the next, or carries `// ipc: any-sender — <why>` on its line or the line above.
//
//   node tools/check_ipc_sender.mjs [root]    root: the tree to check (tests use fixtures); default the repo
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = process.argv[2] ?? fileURLToPath(new URL("..", import.meta.url));
const REGISTER = /(\bipcMain|\.ipc)\s*\.\s*(handle|handleOnce|on|once|addListener)\s*\(/;
const ANY_SENDER = /\/\/\s*ipc: any-sender — \S/;
const hits = [];
const walk = (d) => {
  // loop: NOT-WORTH — electron/'s entries, once per gate run
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(n) && !/\.test\./.test(n)) {
      const lines = readFileSync(p, "utf8").split("\n");
      // loop: NOT-WORTH — one file's lines, once per gate run
      lines.forEach((l, i) => {
        if (!REGISTER.test(l)) return;
        const call = l.slice(l.search(REGISTER)) + "\n" + (lines[i + 1] ?? "");
        if (/\bfromAppPageOnly\s*\(/.test(call) || ANY_SENDER.test(l) || ANY_SENDER.test(lines[i - 1] ?? "")) return;
        hits.push(`${relative(root, p)}:${i + 1}: ${l.trim()}`);
      });
    }
  }
};
walk(join(root, "electron"));
if (hits.length) {
  console.log("IPC sender gate: register the handler through fromAppPageOnly (electron/main/validate.ts), or say why any sender may call it (`// ipc: any-sender — why`):\n" + hits.join("\n"));
  process.exit(1);
}
