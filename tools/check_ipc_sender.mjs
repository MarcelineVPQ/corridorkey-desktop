#!/usr/bin/env node
// Gate: every IPC handler in electron/ checks who sent the message. Each ipcMain (or webContents.ipc)
// handle / handleOnce / on / once / addListener call passes its handler through fromAppPageOnly (validate.ts) on
// the same line or the next (code, not a comment), or carries `// ipc: any-sender — <why>` on its line or the line
// above. ipcMain and .ipc are used only as `ipcMain.method(…)` (or imported): an alias (`const { handle } = ipcMain`,
// `ipcMain["handle"](`, `const h = ipcMain.handle`) would hide a registration from this gate, so it fails.
//
//   node tools/check_ipc_sender.mjs [root]    root: the tree to check (tests use fixtures); default the repo
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = process.argv[2] ?? fileURLToPath(new URL("..", import.meta.url));
const REGISTER = /(\bipcMain|\.ipc)\s*\.\s*(handle|handleOnce|on|once|addListener)\s*\(/;
const ANY_SENDER = /\/\/\s*ipc: any-sender — \S/;
// any other use than a method call `.name(`; ipcMain also as a name in an import list (followed by , or })
const ALIAS = /\bipcMain\b(?!\s*\.\s*\w+\s*\(|\s*[,}])|\.ipc\b(?!\s*\.\s*\w+\s*\()/;
/** The file's code without its comments (block comments keep their line breaks, so line numbers stay). */
const code = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "))
    .split("\n")
    // loop: NOT-WORTH — one file's lines, once per gate run
    .map((l) => l.replace(/\/\/.*$/, ""));
const hits = [];
const walk = (d) => {
  // loop: NOT-WORTH — electron/'s entries, once per gate run
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(n) && !/\.test\./.test(n)) {
      const text = readFileSync(p, "utf8");
      const lines = text.split("\n");
      const codeLines = code(text);
      // loop: NOT-WORTH — one file's lines, once per gate run
      codeLines.forEach((l, i) => {
        if (ALIAS.test(l)) return hits.push(`${relative(root, p)}:${i + 1}: ${lines[i].trim()}    (an alias of ipcMain / .ipc: call it as ipcMain.method(…))`);
        if (!REGISTER.test(l)) return;
        const call = l.slice(l.search(REGISTER)) + "\n" + (codeLines[i + 1] ?? "");
        if (/\bfromAppPageOnly\s*\(/.test(call) || ANY_SENDER.test(lines[i]) || ANY_SENDER.test(lines[i - 1] ?? "")) return;
        hits.push(`${relative(root, p)}:${i + 1}: ${lines[i].trim()}`);
      });
    }
  }
};
walk(join(root, "electron"));
if (hits.length) {
  console.log("IPC sender gate: register the handler through fromAppPageOnly (electron/main/validate.ts), or say why any sender may call it (`// ipc: any-sender — why`):\n" + hits.join("\n"));
  process.exit(1);
}
