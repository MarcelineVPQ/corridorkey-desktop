import { describe, expect, it } from "vitest";
import { cleanPathList, isAppImageMount, relaunchArgs, relaunchEnv, shellArgs, systemdRunArgs } from "../../electron/main/relaunch";

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
  it("systemd-run: a transient user unit with a clean env; older systemd falls back to KillMode=process", () => {
    expect(systemdRunArgs({ target: "/a/CorridorKey-Desktop.AppImage", args: ["--no-sandbox"], env: { HOME: "/h" }, unit: "u1" })).toEqual([
      "--user",
      "--collect",
      "--unit=u1",
      "-p",
      "ExitType=cgroup",
      "--setenv=HOME=/h",
      "--",
      "/a/CorridorKey-Desktop.AppImage",
      "--no-sandbox",
    ]);
    expect(systemdRunArgs({ target: "/t", unit: "u", exitTypeCgroup: false })).toContain("KillMode=process");
  });
  it("the shell fallback passes the target as an argument, never in the script", () => {
    expect(shellArgs("/a b/x'y", ["--z"])).toEqual(["-c", 'sleep 0.5; exec "$0" "$@"', "/a b/x'y", "--z"]);
  });
});
