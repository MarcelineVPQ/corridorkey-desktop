import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cleanPathList, FALLBACK_SCRIPT, fallbackShell, isAppImageMount, relaunchArgs, relaunchEnv, shellArgs, systemdRunArgs } from "../../electron/main/relaunch";

describe("relaunch", () => {
  it("drops AppImage mounts, empties and repeats from PATH", () => {
    expect(isAppImageMount("/tmp/.mount_CorridAbc/usr/bin")).toBe(true);
    expect(isAppImageMount("/usr/bin")).toBe(false);
    expect(cleanPathList("/tmp/.mount_CorridAbc/usr/bin::/usr/bin:/bin:/usr/bin")).toBe("/usr/bin:/bin");
  });
  it("carries the session's variables only", () => {
    const env = relaunchEnv({ DISPLAY: ":0", PATH: "/tmp/.mount_X/bin:/usr/bin", APPDIR: "/tmp/.mount_X", LD_LIBRARY_PATH: "/tmp/.mount_X/lib", CHROME_DESKTOP: "x", HOME: "/home/m" });
    expect(env).toEqual({ DISPLAY: ":0", PATH: "/usr/bin", HOME: "/home/m" });
    expect(relaunchEnv({ PATH: "/tmp/.mount_X/bin" })).toEqual({});
  });
  it("keeps the user's flags, never Chromium's per-process ones", () => {
    expect(relaunchArgs(["/app", "--no-sandbox", "--type=renderer", "--ozone-platform=x11"])).toEqual(["--no-sandbox", "--ozone-platform=x11"]);
  });
  it("systemd-run: a transient user unit with a clean env that waits for the old copy; older systemd falls back to KillMode=process", () => {
    expect(systemdRunArgs({ target: "/a/CorridorKey-Desktop.AppImage", args: ["--no-sandbox"], env: { HOME: "/h" }, unit: "u1", oldPid: 42, shell: "/bin/bash" })).toEqual([
      "--user",
      "--collect",
      "--unit=u1",
      "-p",
      "ExitType=cgroup",
      "--setenv=HOME=/h",
      "--",
      "/bin/bash",
      "-c",
      FALLBACK_SCRIPT,
      "corridorkey-relaunch",
      "42",
      "/a/CorridorKey-Desktop.AppImage",
      "--no-sandbox",
    ]);
    expect(systemdRunArgs({ target: "/t", unit: "u", exitTypeCgroup: false, oldPid: 1, shell: "/bin/sh" })).toContain("KillMode=process");
  });
  it("the shell fallback passes the pid, target and flags as arguments, never in the script", () => {
    expect(shellArgs(42, "/a b/x'y", ["--z"])).toEqual(["-c", FALLBACK_SCRIPT, "corridorkey-relaunch", "42", "/a b/x'y", "--z"]);
    expect(FALLBACK_SCRIPT).not.toContain("x'y");
    expect(fallbackShell((p) => p === "/usr/bin/bash")).toBe("/usr/bin/bash");
    expect(fallbackShell(() => false)).toBe("/bin/sh");
  });

  // Runs the fallback as the updater does: `old` stands for this copy (still quitting), fd 3 for the AppImage
  // runtime's keepalive pipe. The target writes its descriptors and the time it started.
  type Command = (oldPid: number, target: string, args: string[]) => string[];
  const viaShell =
    (shell: string): Command =>
    (pid, target, args) => [shell, ...shellArgs(pid, target, args)];
  // what the systemd unit runs: everything after systemd-run's "--"
  const viaSystemdUnit =
    (shell: string): Command =>
    (pid, target, args) => {
      const a = systemdRunArgs({ target, args, unit: "u", oldPid: pid, shell });
      return a.slice(a.indexOf("--") + 1);
    };
  async function runFallback(command: Command): Promise<{ fds: number[]; startedAfterOld: boolean }> {
    const dir = mkdtempSync(join(tmpdir(), "ck-relaunch-"));
    try {
      const target = join(dir, "new copy's target");
      writeFileSync(target, `#!/bin/sh\nls /proc/$$/fd > "$1"\n[ -e "$2" ] && echo after >> "$1" || echo before >> "$1"\n`);
      chmodSync(target, 0o755);
      const out = join(dir, "fds.txt");
      const gone = join(dir, "old-gone");
      const old = spawn("/bin/sh", ["-c", `sleep 1; touch "${gone}"`]);
      const [program, ...programArgs] = command(old.pid!, target, [out, gone]);
      const child = spawn(program, programArgs, { stdio: ["ignore", "ignore", "ignore", "pipe"] });
      // loop: NOT-WORTH — one test child [bounded: it ends ~1 s after the stand-in old copy]
      await new Promise((r) => child.on("exit", r));
      const lines = readFileSync(out, "utf8").split("\n").filter(Boolean);
      return { fds: lines.filter((l) => /^\d+$/.test(l)).map(Number), startedAfterOld: lines.includes("after") };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  it("the shell fallback (bash) waits for the old copy and drops the descriptors it inherited", async () => {
    const r = await runFallback(viaShell(fallbackShell((p) => p === "/bin/bash")));
    expect(r.fds).toContain(0);
    expect(r.fds).not.toContain(3);
    expect(r.startedAfterOld).toBe(true);
  });
  it("the shell fallback still starts the new copy under plain sh (dash)", async () => {
    const r = await runFallback(viaShell("/bin/sh"));
    expect(r.startedAfterOld).toBe(true);
  });
  it("the systemd unit's command waits for the old copy too (it no longer starts the target at once)", async () => {
    const r = await runFallback(viaSystemdUnit("/bin/bash"));
    expect(r.startedAfterOld).toBe(true);
  });
});
