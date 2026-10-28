// tools/release.sh (read, never run): the engine's checks run before anything is built (audit 2026-10-27 row 1), and
// a CHANGELOG header still saying draft / unreleased is refused (row 15; that one line is run on fixtures); a released
// version is refused, a leftover draft is moved to HEAD, the docs-touch gate reads since the last tag (senior review
// 2026-10-27 N13, S5, S6); the end checks only the released channel's feed at this version, retried; a build that
// changes a tracked file stops the release; --mac extends the published SUMS (whole-code review 2026-10-27). The
// logic is run in bash on fixtures, with stand-ins for gh, node and the signing.
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
  it("runs check:engine, then npm run check against the corridorkey it built, and check_targets.sh before building", () => {
    const check = at(/npm run -s check$/);
    const engine = at(/npm run -s check:engine$/);
    const targets = at(/^tools\/check_targets\.sh$/);
    const build = at(/npm run -s dist:linux/);
    expect([check, engine, targets, build].every((i) => i >= 0)).toBe(true);
    expect(check).toBeLessThan(build);
    expect(engine).toBeLessThan(build);
    expect(targets).toBeLessThan(build);
    // cargo test builds target/debug/corridorkey; the CLI-spec drift check is pointed at it, so it can't skip
    expect(engine).toBeLessThan(check);
    expect(lines[check]).toContain('CK_CLI_BIN="$PWD/engine-rs/target/debug/corridorkey"');
  });

  it("stops when the build changed a tracked file (the shipped cliSpec.json must be the tagged one)", () => {
    const dist = at(/npm run -s dist:win/);
    const dirty = lines.findIndex((l, i) => i > dist && l.startsWith('[ -z "$(git status --porcelain)" ]'));
    expect(dirty).toBeGreaterThan(dist);
    expect(dirty).toBeLessThan(at(/^git push origin main$/));
    const repo = mkdtempSync(join(scratch, "dirty-"));
    // loop: NOT-WORTH — a throwaway repository with one file, 10 s deadline
    spawnSync("bash", ["-c", "git init -q && echo a > spec.json && git add spec.json && git -c user.name=t -c user.email=t@t commit -q -m x"], { cwd: repo, timeout: 10_000 });
    // loop: NOT-WORTH — one line of the script, 10 s deadline
    const run = () => spawnSync("bash", ["-c", `set -euo pipefail; ${lines[dirty]}\necho passed`], { cwd: repo, encoding: "utf8", timeout: 10_000 });
    expect(run().stdout).toContain("passed");
    writeFileSync(join(repo, "spec.json"), "b\n");
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("spec.json");
  });

  it("signs SHA256SUMS / SHA512SUMS and uploads the signatures with them", () => {
    const signed = at(/^sign release\/SHA256SUMS release\/SHA512SUMS$/);
    const upload = at(/gh release upload "v\$v" "release\/\$file"/);
    expect(signed).toBeGreaterThan(at(/sha256sum "\$file" "\$winfile" > SHA256SUMS/));
    expect(signed).toBeLessThan(upload);
    expect(lines[upload]).toContain("release/SHA256SUMS.sig release/SHA512SUMS.sig");
  });

  it("ends by verifying only the released channel's live feed, at this version, with a few tries", () => {
    // every dev release ended in exit 1: it also checked the stable feed, which doesn't exist before 1.0
    const call = lines.findIndex((l) => l.includes("node tools/verify-feed.mjs --channel"));
    expect(call).toBeGreaterThan(0);
    // loop: NOT-WORTH — the script's lines, the last `for try` before the call
    const start = Math.max(...lines.map((l, i) => (i < call && l.startsWith("for try in") ? i : -1)));
    const end = lines.findIndex((l, i) => i > call && l === "done");
    const loop = lines.slice(start, end + 1).join("\n");
    // loop: NOT-WORTH — the script's loop with stand-ins (sleep does nothing), 10 s deadline
    const run = (failures: number) => {
      const dir = mkdtempSync(join(scratch, "verify-"));
      const stub = `set -euo pipefail; n=0; gh() { echo token; }; sleep() { :; }
node() { echo "$*" >> calls; n=$((n + 1)); [ "$n" -gt ${failures} ]; }
v=1.0.0-dev.2 channel=dev mine=latest-dev.json`;
      const r = spawnSync("bash", ["-c", `${stub}\n${loop}\necho passed`], { cwd: dir, encoding: "utf8", timeout: 10_000 });
      return { ...r, calls: readFileSync(join(dir, "calls"), "utf8").trim().split("\n") };
    };
    const ok = run(0);
    expect(ok.stdout).toContain("passed");
    expect(ok.calls).toEqual(["tools/verify-feed.mjs --channel dev --version 1.0.0-dev.2"]);
    const late = run(2);
    expect(late.stdout).toContain("passed");
    expect(late.calls).toHaveLength(3);
    const never = run(6);
    expect(never.status).toBe(1);
    expect(never.stderr).toContain("tools/release.sh --feeds");
  });

  // release.sh runs on the Linux release PC (GNU sha256sum / sha512sum, which a Mac may not have)
  it.skipIf(process.platform !== "linux")("--mac adds the disk image to the published SUMS (its old line replaced), signed, uploaded with them", () => {
    const start = at(/^if \[ "\$mode" = --mac \]; then$/);
    const end = lines.findIndex((l, i) => i > start && l === "fi");
    expect(start).toBeGreaterThan(0);
    expect(start).toBeLessThan(at(/^wiki="\$\(mktemp -d\)"/));
    const block = lines.slice(start, end + 1).join("\n");
    const dir = mkdtempSync(join(scratch, "mac-"));
    const dmg = "CorridorKey-Desktop-1.0.0-dev.2-arm64.dmg";
    writeFileSync(join(dir, dmg), "the disk image\n");
    const stub = `set -euo pipefail; v=1.0.0-dev.2 mode=--mac
gh() {
  case "$2" in
    download) for a in 256 512; do printf 'aaa  CorridorKey-Desktop-1.0.0-dev.2.AppImage\\nold  ${dmg}\\n' > "$5/SHA\${a}SUMS"; done ;;
    upload) echo "$*" > uploaded; cp "$sums/SHA256SUMS" got256; cp "$sums/SHA512SUMS" got512 ;;
  esac
}
sign() { for f in "$@"; do touch "$f.sig"; done; }`;
    // loop: NOT-WORTH — the script's block with stand-ins for gh and the signing, 10 s deadline
    const run = (file: string) => spawnSync("bash", ["-c", `${stub}\n${block}`, "_", "--mac", file], { cwd: dir, encoding: "utf8", timeout: 10_000 });
    expect(run(join(dir, "CorridorKey-Desktop-1.0.0-dev.1-arm64.dmg")).status).toBe(1);
    expect(run(join(dir, dmg)).status).toBe(0);
    const want256 = spawnSync("sha256sum", [dmg], { cwd: dir, encoding: "utf8", timeout: 10_000 }).stdout;
    expect(readFileSync(join(dir, "got256"), "utf8")).toBe(`aaa  CorridorKey-Desktop-1.0.0-dev.2.AppImage\n${want256}`);
    const got512 = readFileSync(join(dir, "got512"), "utf8");
    expect(got512).toContain(`  ${dmg}\n`);
    expect(got512).not.toContain("old");
    const uploaded = readFileSync(join(dir, "uploaded"), "utf8");
    // loop: NOT-WORTH — five names
    for (const f of [dmg, "SHA256SUMS ", "SHA256SUMS.sig", "SHA512SUMS ", "SHA512SUMS.sig"]) expect(uploaded).toContain(f);
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

  it("refuses a CHANGELOG whose top section is another version (N13)", () => {
    const refuse = lines.find((l) => l.includes("top section isn't"));
    expect(refuse).toBeDefined();
    const run = (changelog: string) => {
      writeFileSync(join(scratch, "CHANGELOG.md"), `# Changelog\n\n${changelog}`);
      // loop: NOT-WORTH — one line of the script, 10 s deadline
      return spawnSync("bash", ["-c", `set -euo pipefail; v=1.0.0-dev.2; ${refuse}; echo passed`], { cwd: scratch, encoding: "utf8", timeout: 10_000 });
    };
    // the bump forgotten: package.json still dev.1 under a dev.2 section, or dev.2 listed below a newer one
    expect(run("## 1.0.0-dev.3\n\nNew.\n\n## 1.0.0-dev.2 (2026-10-27)\n\nOld.\n").status).toBe(1);
    expect(run("## 1.0.0-dev.1 (2026-10-26)\n\nOld.\n").status).toBe(1);
    expect(run("## 1.0.0-dev.20 (2026-10-27)\n").status).toBe(1);
    const ok = run("## 1.0.0-dev.2 (2026-10-27)\n\nNew.\n\n## 1.0.0-dev.1 (2026-10-26)\n");
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
      return spawnSync("bash", ["-c", `set -euo pipefail; v=1.0.0-dev.1; state=${state}; mode="\${1:-}"; ${refuse.join("\n")}\necho passed`, "_", ...(arg ? [arg] : [])], {
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
    expect(run("false", "--mac").stdout).toContain("passed");
    expect(run("none", "--mac").status).toBe(1);
    expect(run("none", "", true).status).toBe(1);
    expect(run("none").stdout).toContain("passed");
    expect(run("true").stdout).toContain("passed");
  });

  it("moves a leftover draft to HEAD with the new notes before uploading (S5)", () => {
    const edit = at(/gh release edit "v\$v" --target "\$\(git rev-parse HEAD\)" "\$\{flags\[@\]\}"/);
    expect(edit).toBeGreaterThan(at(/^flags=\(.*--notes-file release\/notes\.md/));
    expect(edit).toBeLessThan(at(/gh release upload "v\$v" "release\/\$file"/));
    expect(lines[edit]).toContain('if [ "$state" = true ]');
  });

  it("runs the docs-touch gate over the commits since the last v* tag before building (S6)", () => {
    const docs = at(/^node tools\/check_docs_touch\.mjs "\$\(git describe --tags --abbrev=0 --match 'v\*'\)\.\.HEAD"$/);
    expect(docs).toBeGreaterThan(at(/^if \[ "\$state" != false \]/));
    expect(docs).toBeLessThan(at(/npm run -s dist:linux/));
  });
});
