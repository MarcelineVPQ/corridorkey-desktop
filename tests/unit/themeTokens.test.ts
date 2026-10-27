// The theme gate's token check (audit row 17): run on a small tree of its own, as the security gate's test does.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const gate = fileURLToPath(new URL("../../.hooks/check_theme_colors.mjs", import.meta.url));

function run(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "ck-theme-"));
  try {
    const all = { "src/ui/theme/palette.ts": "", "src/ui/glass/liquidGlass.ts": "", "electron/main.ts": "", ...files };
    // loop: NOT-WORTH — a few fixture files
    for (const [p, text] of Object.entries(all)) {
      mkdirSync(dirname(join(root, p)), { recursive: true });
      writeFileSync(join(root, p), text);
    }
    return spawnSync(process.execPath, [gate], { cwd: root, encoding: "utf8", timeout: 30_000 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("the theme gate's tokens", () => {
  it("an unused token (--checker-a before 2026-10-27) and an undefined var() fail", () => {
    const r = run({
      "src/styles/tokens.css": ":root {\n  --accent: #00b140;\n  --checker-a: #3a3f4b;\n}\n",
      "src/styles/app.css": ".b {\n  color: var(--accent);\n  width: var(--rail-w);\n}\n",
    });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("--checker-a is defined but nothing uses it");
    expect(r.stdout).toContain("var(--rail-w) is used but nothing defines --rail-w");
  });

  it("passes when every token is used and every var() is defined (an inline style's variable counts)", () => {
    const r = run({
      "src/styles/tokens.css": ":root {\n  --accent: #00b140;\n}\n",
      "src/styles/app.css": ".b {\n  color: var(--accent);\n  width: var(--rail-w);\n}\n",
      "src/ui/Rail.tsx": 'export const s = { ["--rail-w" as string]: "48px" };\n',
    });
    expect(r.stdout).toBe("");
    expect(r.status).toBe(0);
  });
});
