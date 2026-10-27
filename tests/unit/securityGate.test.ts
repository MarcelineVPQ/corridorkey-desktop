// The Electron security gate (.hooks/check_electron_security.sh) on fixture trees: each forbidden pattern fails it,
// a missing or loosened Content-Security-Policy fails it, and the real tree passes.
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

let n = 0;
/** A fixture tree: the real electron.vite.config.ts (or `viteConfig`), plus `files`; the gate's exit code and output. */
function runGate(files: Record<string, string>, viteConfig = config): { code: number | null; out: string } {
  const root = join(scratch, String(n++));
  mkdirSync(join(root, "electron"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "electron.vite.config.ts"), viteConfig);
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
  ];
  // loop: NOT-WORTH — a dozen fixtures, each in electron/ and in src/
  for (const [name, code] of forbidden) {
    it(`fails on ${name}`, () => {
      expect(runGate({ "electron/main/bad.ts": code }).code).toBe(1);
      expect(runGate({ "src/ui/bad.tsx": code }).code).toBe(1);
    });
  }

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
});
