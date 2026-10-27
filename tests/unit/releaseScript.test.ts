// tools/release.sh (read, never run): the engine's checks run before anything is built (audit 2026-10-27 row 1), and
// a CHANGELOG header still saying draft / unreleased is refused (row 15; that one line is run on fixtures); a released
// version is refused, a leftover draft is moved to HEAD, the docs-touch gate reads since the last tag (senior review
// 2026-10-27 N13, S5, S6).
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

  it("refuses a version already released unless --feeds, and --feeds unless published (N13)", () => {
    const refuse = lines.filter((l) => /^\[ "\$state" (=|!=) (false|none) \]/.test(l));
    expect(refuse).toHaveLength(3);
    expect(at(/^state="/)).toBeLessThan(at(/^\[ "\$state" = false \]/));
    expect(at(/^\[ "\$state" = none \]/)).toBeLessThan(at(/npm run -s check$/));
    // loop: NOT-WORTH — three lines in a throwaway repository, 10 s deadline
    const run = (state: string, arg = "", tag = false) => {
      const repo = mkdtempSync(join(scratch, "repo-"));
      spawnSync("bash", ["-c", `git init -q && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m x${tag ? " && git tag v1.0.0-dev.1" : ""}`], { cwd: repo, timeout: 10_000 });
      return spawnSync("bash", ["-c", `set -euo pipefail; v=1.0.0-dev.1; state=${state}; ${refuse.join("\n")}\necho passed`, "_", ...(arg ? [arg] : [])], {
        cwd: repo,
        encoding: "utf8",
        timeout: 10_000,
      });
    };
    expect(run("false").status).toBe(1);
    expect(run("false").stderr).toContain("released already");
    expect(run("false", "--feeds").stdout).toContain("passed");
    expect(run("none", "--feeds").status).toBe(1);
    expect(run("true", "--feeds").status).toBe(1);
    expect(run("none", "", true).status).toBe(1);
    expect(run("none").stdout).toContain("passed");
    expect(run("true").stdout).toContain("passed");
  });

  it("moves a leftover draft to HEAD with the new notes before uploading (S5)", () => {
    const edit = at(/gh release edit "v\$v" --target "\$\(git rev-parse HEAD\)" "\$\{flags\[@\]\}"/);
    expect(edit).toBeGreaterThan(at(/^flags=\(.*--notes-file release\/notes\.md/));
    expect(edit).toBeLessThan(at(/gh release upload/));
    expect(lines[edit]).toContain('if [ "$state" = true ]');
  });

  it("runs the docs-touch gate over the commits since the last v* tag before building (S6)", () => {
    const docs = at(/^node tools\/check_docs_touch\.mjs "\$\(git describe --tags --abbrev=0 --match 'v\*'\)\.\.HEAD"$/);
    expect(docs).toBeGreaterThan(at(/^if \[ "\$state" != false \]/));
    expect(docs).toBeLessThan(at(/npm run -s dist:linux/));
  });
});
