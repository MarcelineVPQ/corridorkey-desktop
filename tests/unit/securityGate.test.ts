// The Electron security gate (.hooks/check_electron_security.sh) on fixture trees: each forbidden pattern fails it,
// a missing or loosened Content-Security-Policy fails it, so does a missing permission or navigation handler, and the
// real tree passes.
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const gate = join(repo, ".hooks/check_electron_security.sh");
const config = readFileSync(join(repo, "electron.vite.config.ts"), "utf8");
const scratch = mkdtempSync(join(tmpdir(), "ck-security-gate-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** The window's permission and navigation handlers the gate requires (as electron/main/index.ts has them). */
const WINDOW = [
  "win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));",
  "win.webContents.session.setPermissionCheckHandler(() => false);",
  'win.webContents.on("will-navigate", (e) => e.preventDefault());',
  'win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));',
].join("\n");

let n = 0;
/**
 * A fixture tree: the real electron.vite.config.ts (or `viteConfig`), electron/main/window.ts = WINDOW, plus `files`
 * (which can replace window.ts); the gate's exit code and output.
 */
function runGate(files: Record<string, string>, viteConfig = config): { code: number | null; out: string } {
  const root = join(scratch, String(n++));
  mkdirSync(join(root, "electron/main"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "electron.vite.config.ts"), viteConfig);
  writeFileSync(join(root, "electron/main/window.ts"), WINDOW);
  // loop: NOT-WORTH — one or two fixture files
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  // loop: NOT-WORTH — a grep over a fixture tree, 10 s deadline
  const r = spawnSync("bash", [gate, root], { encoding: "utf8", timeout: 10_000 });
  return { code: r.status, out: r.stdout + r.stderr };
}

describe("Electron security gate", () => {
  it("passes on the real tree", () => {
    // loop: NOT-WORTH — one grep over electron/ and src/, 30 s deadline
    const r = spawnSync("bash", [gate], { cwd: repo, encoding: "utf8", timeout: 30_000 });
    expect(r.stdout + r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  it("passes on a clean fixture: execFile and spawn without a shell, a RegExp's exec", () => {
    const ok = [
      'import { execFile, spawn } from "node:child_process";',
      'execFile("ffmpeg", ["-version"], () => {});',
      'spawn("corridorkey", ["info"], { shell: false, windowsHide: true });',
      "const m = /a(b)/.exec(s);",
      "const n = re.exec(s);",
    ].join("\n");
    expect(runGate({ "electron/main/ok.ts": ok, "src/ok.tsx": "export const x = /x/.exec('x');" }).code).toBe(0);
  });

  const forbidden: [string, string][] = [
    ["shell: true", 'spawn("x", [], { shell: true });'],
    ["shell:true", 'execFile("x", [], {shell:true});'],
    ["exec(", 'import { exec } from "node:child_process";\nexec("ls");'],
    ["execSync(", 'import { execSync } from "child_process";\nexecSync("ls");'],
    ["cp.execSync(", "cp.execSync('ls');"],
    ["child_process.exec", 'import child_process from "node:child_process";\nchild_process.exec("ls");'],
    ["exec as", 'import { exec as run } from "node:child_process";\nrun("ls");'],
    ["a namespace import", 'import * as cp from "node:child_process";\ncp.exec("ls");'],
    ["a default import", 'import cp from "child_process";\ncp.exec("ls");'],
    ["require", 'const cp = require("child_process");\ncp.exec("ls");'],
    ["nodeIntegration", "new BrowserWindow({ webPreferences: { nodeIntegration: true } });"],
    // the senior review of 2026-10-26 (S5): a shell by another spelling
    ['shell: "/bin/bash"', 'spawn(x, [], { shell: "/bin/bash" });'],
    ["shell: <expression>", 'spawn(x, [], { shell: process.platform === "win32" });'],
    ["shell on its own line", "spawn(x, [], {\n  shell: useShell,\n});"],
    ["sh -c", 'spawn("/bin/sh", ["-c", line]);'],
    ["bash by name", 'spawn("bash", args);'],
    ["cmd.exe /c", 'execFile("cmd.exe", ["/d", "/s", "/c", line]);'],
    ["powershell -Command", 'spawnSync("powershell.exe", ["-NoProfile", "-Command", line]);'],
    ["a dynamic import", 'const cp = await import("node:child_process");\ncp.exec(line);'],
    ["a destructured dynamic import", 'const { spawn: run } = await import("child_process");'],
    ["shell.openPath", "await shell.openPath(p);"],
  ];
  // loop: NOT-WORTH — a dozen fixtures, each in electron/ and in src/
  for (const [name, code] of forbidden) {
    it(`fails on ${name}`, () => {
      expect(runGate({ "electron/main/bad.ts": code }).code).toBe(1);
      expect(runGate({ "src/ui/bad.tsx": code }).code).toBe(1);
    });
  }

  it("lets a reviewed shell use through with its marker on the line or the line above", () => {
    const ok = [
      "// gate: shell-ok — a fixed script, no user text",
      'spawn("/bin/sh", ["-c", SCRIPT]);',
      "const err = await shell.openPath(p); // gate: shell-ok — the app's own folder",
      "spawn(x, [], { shell: false });",
    ].join("\n");
    const r = runGate({ "electron/main/ok.ts": ok });
    expect(r.out).toBe("");
    expect(r.code).toBe(0);
    // the marker covers only its own line and the next one
    expect(runGate({ "electron/main/bad.ts": '// gate: shell-ok — x\nconst a = 1;\nspawn("/bin/sh", ["-c", line]);' }).code).toBe(1);
  });

  it("fails without the Content-Security-Policy, or with a loosened one", () => {
    expect(runGate({}, "export default {};").code).toBe(1);
    const cases = [
      config.replace("\"script-src 'self'\"", "\"script-src 'self' 'unsafe-inline'\""),
      config.replace("\"default-src 'self'\"", '"default-src *"'),
      config.replace("\"object-src 'none'\"", '""'),
      config.replace("\"base-uri 'none'\"", '""'),
      config.replace("\"script-src 'self'\"", "\"script-src 'self' 'unsafe-eval'\""),
      config.replace("plugins: [react(), csp()]", "plugins: [react()]"),
    ];
    // loop: NOT-WORTH — six fixtures
    for (const c of cases) {
      expect(c).not.toBe(config);
      const r = runGate({}, c);
      expect(r.code, r.out).toBe(1);
    }
  });

  it("fails without the permission handlers, the will-navigate block or the window-open handler, or allowing a window", () => {
    const lines = WINDOW.split("\n");
    // loop: NOT-WORTH — four fixtures, one handler left out each
    for (const left of lines) {
      const r = runGate({ "electron/main/window.ts": lines.filter((l) => l !== left).join("\n") });
      expect(r.code, left).toBe(1);
      expect(r.out).toContain("permissions / navigation");
    }
    const loose = [WINDOW.replace("(e) => e.preventDefault()", "() => {}"), WINDOW.replace('action: "deny"', 'action: "allow"')];
    // loop: NOT-WORTH — two fixtures
    for (const w of loose) expect(runGate({ "electron/main/window.ts": w }).code, w).toBe(1);
  });
});
