// The IPC sender gate (tools/check_ipc_sender.mjs) on fixture trees: a handler registered without the sender check
// fails it, one through fromAppPageOnly or with its any-sender reason passes, and the real tree passes.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const gate = join(repo, "tools/check_ipc_sender.mjs");
const scratch = mkdtempSync(join(tmpdir(), "ck-ipc-gate-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let n = 0;
/** A fixture tree with electron/main/index.ts = `code`; the gate's exit code and output. */
function runGate(code: string): { code: number | null; out: string } {
  const root = join(scratch, String(n++));
  mkdirSync(join(root, "electron/main"), { recursive: true });
  writeFileSync(join(root, "electron/main/index.ts"), code);
  // loop: NOT-WORTH — one small fixture tree, 10 s deadline
  const r = spawnSync(process.execPath, [gate, root], { encoding: "utf8", timeout: 10_000 });
  return { code: r.status, out: r.stdout + r.stderr };
}

describe("IPC sender gate", () => {
  it("passes on the real tree", () => {
    // loop: NOT-WORTH — one walk over electron/, 30 s deadline
    const r = spawnSync(process.execPath, [gate], { cwd: repo, encoding: "utf8", timeout: 30_000 });
    expect(r.stdout + r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  it("passes handlers registered through fromAppPageOnly, or with their any-sender reason", () => {
    const ok = [
      "ipcMain.handle(channel, fromAppPageOnly(appPage, fn));",
      "ipcMain.on(",
      "  channel, fromAppPageOnly(appPage, fn));",
      "// ipc: any-sender — a ping that reads nothing",
      'ipcMain.handle("ping", () => "pong");',
      'ipcMain.handle("pong", () => "ping"); // ipc: any-sender — reads nothing',
      'ipcRenderer.on("ck:state", cb);',
      'import { app, ipcMain } from "electron";',
      "import {",
      "  ipcMain,",
      '} from "electron";',
      "/* ipcMain handlers all go through fromAppPageOnly */",
      "// see ipcMain.handle above",
    ].join("\n");
    const r = runGate(ok);
    expect(r.out).toBe("");
    expect(r.code).toBe(0);
  });

  const unchecked: [string, string][] = [
    ["ipcMain.handle", 'ipcMain.handle("ck:remove-storage", async (_e, id) => remove(id));'],
    ["ipcMain.on", 'ipcMain.on("ck:set-visible", (_e, v) => show(v));'],
    ["ipcMain.once", 'ipcMain.once("x", () => {});'],
    ["ipcMain.handleOnce", 'ipcMain.handleOnce("x", () => 1);'],
    ["ipcMain.addListener", 'ipcMain.addListener("x", () => {});'],
    ["webContents.ipc.handle", 'win.webContents.ipc.handle("x", () => 1);'],
    ["a reason-less marker", '// ipc: any-sender\nipcMain.handle("x", () => 1);'],
    ["a marker two lines up", '// ipc: any-sender — why\nconst a = 1;\nipcMain.handle("x", () => 1);'],
    // review N2: aliases hide a registration; the check in a comment isn't the check
    ["a destructured ipcMain", 'const { handle } = ipcMain;\nhandle("x", () => 1);'],
    ["ipcMain by index", 'ipcMain["handle"]("x", () => 1);'],
    ["ipcMain kept in a variable", "const m = ipcMain;"],
    ["a method kept in a variable", "const h = ipcMain.handle;"],
    ["an aliased import", 'import { ipcMain as m } from "electron";'],
    ["an .ipc alias", "const { handle } = win.webContents.ipc;"],
    ["fromAppPageOnly in a comment on the next line", 'ipcMain.handle("x", () => 1);\n// fromAppPageOnly(appPage, fn)'],
    ["fromAppPageOnly in a trailing comment", 'ipcMain.handle("x", (e) => 1); // TODO fromAppPageOnly(appPage, fn)'],
    ["fromAppPageOnly in a block comment", 'ipcMain.handle("x", /* fromAppPageOnly( */ () => 1);'],
  ];
  // loop: NOT-WORTH — seventeen fixtures
  for (const [name, code] of unchecked) {
    it(`fails on ${name} without the sender check`, () => {
      const r = runGate(code);
      expect(r.code, r.out).toBe(1);
      expect(r.out).toContain("electron/main/index.ts:");
    });
  }
});
