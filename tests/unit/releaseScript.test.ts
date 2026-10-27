// tools/release.sh (read, never run): the engine's checks run before anything is built (audit 2026-10-27 row 1), and
// a CHANGELOG header still saying draft / unreleased is refused (row 15; that one line is run on fixtures).
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const script = readFileSync(new URL("../../tools/release.sh", import.meta.url), "utf8");
const lines = script.split("\n");
const at = (re: RegExp) => lines.findIndex((l) => re.test(l) && !l.trimStart().startsWith("#"));
const scratch = mkdtempSync(join(tmpdir(), "ck-release-script-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("release script", () => {
  it("runs npm run check, check:engine and check_targets.sh before building", () => {
    const check = at(/npm run -s check$/);
    const engine = at(/npm run -s check:engine$/);
    const targets = at(/^tools\/check_targets\.sh$/);
    const build = at(/npm run -s dist:linux/);
    expect([check, engine, targets, build].every((i) => i >= 0)).toBe(true);
    expect(check).toBeLessThan(build);
    expect(engine).toBeLessThan(build);
    expect(targets).toBeLessThan(build);
  });

  it("refuses a CHANGELOG header that says draft or unreleased", () => {
    const refuse = lines.find((l) => /draft\|unreleased/.test(l) && l.includes("CHANGELOG.md"));
    expect(refuse).toBeDefined();
    const run = (header: string) => {
      writeFileSync(join(scratch, "CHANGELOG.md"), `# Changelog\n\n${header}\n\nNotes.\n`);
      // loop: NOT-WORTH — one grep line, 10 s deadline
      return spawnSync("bash", ["-c", `set -euo pipefail; v=1.0.0-dev.2; ${refuse}; echo passed`], { cwd: scratch, encoding: "utf8", timeout: 10_000 });
    };
    expect(run("## 1.0.0-dev.2 (draft, unreleased)").status).toBe(1);
    expect(run("## 1.0.0-dev.2 (Draft)").status).toBe(1);
    expect(run("## 1.0.0-dev.2 Unreleased").status).toBe(1);
    const ok = run("## 1.0.0-dev.2 (2026-10-27)");
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain("passed");
  });
});
