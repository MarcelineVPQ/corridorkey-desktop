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
  it.skipIf(process.platform !== "linux")(
    "--mac takes the image of a green macOS run of the tag's commit only, adds it to the published SUMS (its old line replaced), signed, uploaded with them",
    () => {
      const start = at(/^if \[ "\$mode" = --mac \]; then$/);
      const end = lines.findIndex((l, i) => i > start && l === "fi");
      expect(start).toBeGreaterThan(0);
      expect(start).toBeLessThan(at(/^wiki="\$\(mktemp -d\)"/));
      const block = lines.slice(start, end + 1).join("\n");
      const dir = mkdtempSync(join(scratch, "mac-"));
      const dmg = "CorridorKey-Desktop-1.0.0-dev.2-arm64.dmg";
      // runs: 1 = the tag's commit, green; 2 = another commit (main after the release); 3 = failed; 4 = another workflow;
      // 5 = the tag's, but its artifact has another version's image
      const stub = `set -euo pipefail; v=1.0.0-dev.2 mode=--mac
git() { echo tagsha; }
gh() {
  case "$1 $2" in
    "run view") case "$3" in 1|5) printf 'macOS\\ttagsha\\tsuccess\\n' ;; 2) printf 'macOS\\tmainsha\\tsuccess\\n' ;; 3) printf 'macOS\\ttagsha\\tfailure\\n' ;; 4) printf 'Windows\\ttagsha\\tsuccess\\n' ;; esac ;;
    "run download") mkdir -p "$7"; if [ "$3" = 5 ]; then echo x > "$7/CorridorKey-Desktop-1.0.0-dev.1-arm64.dmg"; else echo 'the disk image' > "$7/${dmg}"; fi ;;
    "release download") for a in 256 512; do printf 'aaa  CorridorKey-Desktop-1.0.0-dev.2.AppImage\\nold  ${dmg}\\n' > "$5/SHA\${a}SUMS"; done ;;
    "release upload") echo "$*" > uploaded; cp "$sums/SHA256SUMS" got256; cp "$sums/SHA512SUMS" got512; cp "$sums/${dmg}" got.dmg ;;
  esac
}
sign() { for f in "$@"; do touch "$f.sig"; done; }`;
      // loop: NOT-WORTH — the script's block with stand-ins for git, gh and the signing, 10 s deadline
      const run = (id: string) => spawnSync("bash", ["-c", `${stub}\n${block}`, "_", "--mac", id], { cwd: dir, encoding: "utf8", timeout: 10_000 });
      expect(run("2").stderr).toContain("built mainsha, not v1.0.0-dev.2 (tagsha)");
      expect(run("3").status).toBe(1);
      expect(run("4").status).toBe(1);
      expect(run("5").stderr).toContain(`has no ${dmg}`);
      expect(spawnSync("ls", [dir], { encoding: "utf8", timeout: 10_000 }).stdout).not.toContain("uploaded");
      expect(run("1").status).toBe(0);
      writeFileSync(join(dir, dmg), "the disk image\n");
      expect(readFileSync(join(dir, "got.dmg"), "utf8")).toBe("the disk image\n");
      const want256 = spawnSync("sha256sum", [dmg], { cwd: dir, encoding: "utf8", timeout: 10_000 }).stdout;
      expect(readFileSync(join(dir, "got256"), "utf8")).toBe(`aaa  CorridorKey-Desktop-1.0.0-dev.2.AppImage\n${want256}`);
      const got512 = readFileSync(join(dir, "got512"), "utf8");
      expect(got512).toContain(`  ${dmg}\n`);
      expect(got512).not.toContain("old");
      const uploaded = readFileSync(join(dir, "uploaded"), "utf8");
      // loop: NOT-WORTH — five names
      for (const f of [dmg, "SHA256SUMS ", "SHA256SUMS.sig", "SHA512SUMS ", "SHA512SUMS.sig"]) expect(uploaded).toContain(f);
    },
  );

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
    const refuse = lines.filter((l) => /^\[ "\$state" (=|!=) (false|none) \]|^\[ "\$mode" = --publish \]/.test(l));
    expect(refuse).toHaveLength(4);
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
    // --publish: only a draft (release re-review 2026-10-28 #2)
    expect(run("true", "--publish").stdout).toContain("passed");
    expect(run("none", "--publish").stderr).toContain("no draft to publish");
    expect(run("false", "--publish").status).toBe(1);
  });

  it("moves a leftover draft to HEAD with the new notes before uploading (S5)", () => {
    const start = at(/^flags=\(.*--notes-file release\/notes\.md/);
    const edit = at(/gh release edit "v\$v" --target "\$\(git rev-parse HEAD\)" "\$\{flags\[@\]\}"/);
    expect(start).toBeGreaterThan(0);
    expect(edit).toBeGreaterThan(start);
    expect(edit).toBeLessThan(at(/gh release upload "v\$v" "release\/\$file"/));
    // the flags, the dev/stable choice and the edit-or-create lines, run with a stand-in gh in a throwaway repository
    const block = lines.slice(start, edit + 2).join("\n");
    const repo = mkdtempSync(join(scratch, "draft-"));
    // loop: NOT-WORTH — a throwaway repository with one commit, 10 s deadline
    spawnSync("bash", ["-c", "git init -q && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m x"], { cwd: repo, timeout: 10_000 });
    const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8", timeout: 10_000 }).stdout.trim();
    // loop: NOT-WORTH — the script's lines with a stand-in gh, 10 s deadline
    const run = (state: string, dev: boolean) => {
      const stub = `set -euo pipefail; v=1.0.0-dev.2 state=${state} dev=${dev}; gh() { echo "$*"; }`;
      return spawnSync("bash", ["-c", `${stub}\n${block}`], { cwd: repo, encoding: "utf8", timeout: 10_000 });
    };
    const notes = "--title CorridorKey 1.0.0-dev.2 --notes-file release/notes.md";
    // a draft left by a failed run: edited onto this commit with the new notes, never created again
    const draft = run("true", true);
    expect(draft.status).toBe(0);
    expect(draft.stdout.trim()).toBe(`release edit v1.0.0-dev.2 --target ${head} ${notes} --prerelease --latest=false`);
    // nothing yet: a new draft at this commit
    expect(run("none", false).stdout.trim()).toBe(`release create v1.0.0-dev.2 --draft --target ${head} ${notes} --latest`);
  });

  it("runs the docs-touch gate over the commits since the last v* tag before building (S6)", () => {
    const docs = at(/^node tools\/check_docs_touch\.mjs /);
    expect(docs).toBeGreaterThan(at(/^elif \[ "\$state" != false \]/));
    expect(docs).toBeLessThan(at(/npm run -s dist:linux/));
    // the line run with a stand-in node in a repository whose newest tag isn't a release tag
    const repo = mkdtempSync(join(scratch, "docs-"));
    const commit = "git -c user.name=t -c user.email=t@t commit -q --allow-empty -m x";
    // loop: NOT-WORTH — a throwaway repository with three commits and two tags, 10 s deadline
    spawnSync("bash", ["-c", `git init -q && ${commit} && git tag v1.0.0-dev.1 && ${commit} && git tag other && ${commit}`], { cwd: repo, timeout: 10_000 });
    // loop: NOT-WORTH — one line of the script, 10 s deadline
    const r = spawnSync("bash", ["-c", `set -euo pipefail; node() { echo "$*"; }\n${lines[docs]}`], { cwd: repo, encoding: "utf8", timeout: 10_000 });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("tools/check_docs_touch.mjs v1.0.0-dev.1..HEAD");
  });

  it("checks node_modules against the lock and wants a green Windows CI run of HEAD before building (release review 2026-10-28 #4, #6)", () => {
    const nm = at(/^node tools\/check_node_modules\.mjs /);
    const win = at(/gh run list --workflow windows\.yml --commit "\$head" --status success/);
    const build = at(/npm run -s dist:linux/);
    expect(nm).toBeGreaterThan(at(/^if \[ "\$mode" = --mac \]; then$/));
    expect(nm).toBeLessThan(build);
    expect(win).toBeGreaterThan(at(/^elif \[ "\$state" != false \]/));
    expect(win).toBeLessThan(at(/npm run -s check:engine$/));
    // the gate's lines with a stand-in gh, in a throwaway repository
    const block = lines.slice(win - 1, win + 4).join("\n");
    const repo = mkdtempSync(join(scratch, "win-"));
    // loop: NOT-WORTH — a throwaway repository with one commit, 10 s deadline
    spawnSync("bash", ["-c", "git init -q && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m x"], { cwd: repo, timeout: 10_000 });
    const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8", timeout: 10_000 }).stdout.trim();
    // loop: NOT-WORTH — the gate with a stand-in gh, 10 s deadline
    const run = (green: string) =>
      spawnSync("bash", ["-c", `set -euo pipefail; gh() { echo "$*" > asked; [ "$6" = "${green}" ] && echo 1 || echo 0; }\n${block}\necho passed`], { cwd: repo, encoding: "utf8", timeout: 10_000 });
    const no = run("other");
    expect(no.status).toBe(1);
    expect(no.stderr).toContain("gh workflow run windows.yml --ref main");
    const ok = run(head);
    expect(ok.stdout).toContain("passed");
    expect(readFileSync(join(repo, "asked"), "utf8")).toContain(`--commit ${head} --status success`);
  });

  it("starts the packaged Linux build in an isolated copy and refuses to publish unless it shows its first page (#5)", () => {
    const iso = at(/tools\/isolated\.sh --state "\$smoke" --packaged release\/linux-unpacked &/);
    const drive = at(/node tools\/drive\.mjs --state "\$smoke"/);
    expect(iso).toBeGreaterThan(at(/^\[ -z "\$\(git status --porcelain\)" \] \|\| \{ echo "release: the build changed/));
    expect(drive).toBeGreaterThan(iso);
    expect(drive).toBeLessThan(at(/^git push origin main$/));
    expect(script).toContain("grep -qx 'eval: true' \"$smoke/drive.log\"");
  });

  it("refuses to publish when GitHub's digest of an upload isn't the signed SHA256SUMS' (#11)", () => {
    const fn = at(/^digests_match\(\) \{$/);
    const block = lines.slice(fn, lines.indexOf("}", fn) + 1).join("\n") + "\ndigests_match";
    // checked after the upload, and again just before --publish publishes
    const calls = lines.flatMap((l, i) => (l === "digests_match" ? [i] : []));
    expect(calls).toHaveLength(2);
    expect(calls[0]).toBeLessThan(at(/gh release edit "v\$v" --draft=false/));
    expect(calls[1]).toBeGreaterThan(at(/gh release upload "v\$v" "release\/\$file"/));
    const dir = mkdtempSync(join(scratch, "digest-"));
    // loop: NOT-WORTH — two lines with a stand-in gh, 10 s deadline
    const run = (served: string) => {
      spawnSync("bash", ["-c", "mkdir -p release && printf 'aaa  A.AppImage\\nbbb  B-Setup.exe\\n' > release/SHA256SUMS"], { cwd: dir, timeout: 10_000 });
      return spawnSync("bash", ["-c", `set -euo pipefail; v=1; gh() { printf '${served}'; }\n${block}\necho passed`], { cwd: dir, encoding: "utf8", timeout: 10_000 });
    };
    expect(run("aaa  A.AppImage\\nbbb  B-Setup.exe\\nccc  SHA256SUMS\\n").stdout).toContain("passed");
    const bad = run("aaa  A.AppImage\\nzzz  B-Setup.exe\\n");
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("bbb  B-Setup.exe");
    expect(run("none  A.AppImage\\nnone  B-Setup.exe\\n").status).toBe(1);
  });

  // release re-review 2026-10-28 #2: the Windows installer starts in the VM before anything is public
  it("leaves the release a draft after uploading; only --publish, on this commit's draft, publishes it", () => {
    const publish = at(/gh release edit "v\$v" --draft=false/);
    const branch = at(/^if \[ "\$mode" = --publish \]; then$/);
    const build = at(/^elif \[ "\$state" != false \]/);
    // the only --draft=false is in the --publish branch, before the build branch
    expect(script.match(/--draft=false/g)).toHaveLength(1);
    expect(publish).toBeGreaterThan(branch);
    expect(publish).toBeLessThan(build);
    // the build branch ends with the draft left and exit 0, after the upload
    const upload = at(/gh release upload "v\$v" "release\/\$file"/);
    const stop = lines.findIndex((l, i) => i > upload && l === "exit 0");
    expect(stop).toBeGreaterThan(upload);
    expect(stop).toBeLessThan(lines.findIndex((l, i) => i > build && l === "else"));
    expect(lines.slice(upload, stop).join("\n")).toContain("tools/release.sh --publish");
    // --publish refuses a draft on another commit (the first run's, before a new commit)
    const block = lines.slice(branch + 3, branch + 5).join("\n");
    const repo = mkdtempSync(join(scratch, "publish-"));
    // loop: NOT-WORTH — a throwaway repository with one commit, 10 s deadline
    spawnSync("bash", ["-c", "git init -q && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m x"], { cwd: repo, timeout: 10_000 });
    const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8", timeout: 10_000 }).stdout.trim();
    // loop: NOT-WORTH — two lines with a stand-in gh, 10 s deadline
    const run = (target: string) => spawnSync("bash", ["-c", `set -euo pipefail; v=1; gh() { echo ${target}; }\n${block}\necho passed`], { cwd: repo, encoding: "utf8", timeout: 10_000 });
    expect(run(head).stdout).toContain("passed");
    expect(run("0000000").stderr).toContain("isn't on this commit");
  });

  // release re-review 2026-10-28 #3: the packaged --ck-headless start had never run
  it("runs the packaged corridorkey run on a two-line script, isolated, and needs both lines and exit 0", () => {
    const start = at(/^printf 'version\\necho ck-run-check\\n' > "\$smoke\/check\.ckcmd"$/);
    const end = lines.findIndex((l, i) => i > start && l === "fi");
    expect(start).toBeGreaterThan(at(/node tools\/drive\.mjs --state "\$smoke"/));
    expect(end).toBeLessThan(at(/^git push origin main$/));
    const block = lines.slice(start, end + 1).join("\n");
    expect(block).toContain('env -i HOME="$smoke/home"');
    // loop: NOT-WORTH — one run of the block with a stand-in corridorkey, 10 s deadline
    const run = (out: string, status: number) => {
      const dir = mkdtempSync(join(scratch, "run-"));
      const bin = join(dir, "release/linux-unpacked/resources/engine");
      spawnSync("bash", ["-c", `mkdir -p "${bin}" "${dir}/smoke/home"`], { timeout: 10_000 });
      writeFileSync(join(bin, "corridorkey"), `#!/bin/sh\n[ "$1" = run ] && [ -f "$2" ] && [ -z "$DISPLAY$WAYLAND_DISPLAY" ] || exit 3\nprintf '${out}'\nexit ${status}\n`);
      spawnSync("chmod", ["+x", join(bin, "corridorkey")], { timeout: 10_000 });
      return spawnSync("bash", ["-c", `set -euo pipefail; v=1.0.0-dev.2; smoke="$PWD/smoke"; CAP=(); USER=t\n${block}\necho passed`], {
        cwd: dir,
        encoding: "utf8",
        timeout: 10_000,
        env: { ...process.env, DISPLAY: ":0" },
      });
    };
    const both = "CorridorKey 1.0.0-dev.2 (the app and its corridorkey command line: one version)\\nck-run-check\\n";
    expect(run(both, 0).stdout).toContain("passed");
    expect(run(both, 1).stderr).toContain("didn't run its script");
    expect(run("CorridorKey 1.0.0-dev.2 (x)\\n", 0).status).toBe(1);
    expect(run("CorridorKey 1.0.0-dev.1 (x)\\nck-run-check\\n", 0).status).toBe(1);
  });
});
