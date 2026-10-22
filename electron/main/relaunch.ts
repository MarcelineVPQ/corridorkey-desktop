// Starting the app again after an update (Sonata's relaunch.js, pure: env, argv
// and paths in; a command out; tests/unit/relaunch.test.ts).
//
// An AppImage runs from a FUSE mount (/tmp/.mount_CorridXXXXXX), and its AppRun
// puts that mount at the front of PATH (and LD_LIBRARY_PATH). The mount lives
// only as long as that run. Sonata learned (0.15.35-dev.1, 2026-10-16) that a
// relaunch passing its own PATH on made each new copy inherit dead mounts, and
// execvp stops at the first ENOTCONN on PATH. And inheriting this process's
// Chromium environment crashed the new instance. So the new copy gets the
// session's variables only, PATH without any AppImage mount, started through
// the user's systemd (outside this AppImage's mount and process tree).

// a PATH-style entry inside an AppImage's mount (the runtime names it .mount_<name><random>)
export function isAppImageMount(dir: string): boolean {
  return /(^|\/)\.mount_[^/]+(\/|$)/.test(dir);
}

// a PATH-style list without AppImage mounts, empty entries or repeats
export function cleanPathList(list: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  // loop: NOT-WORTH — the entries of one PATH-style variable, once per restart
  for (const d of list.split(":")) {
    if (!d || seen.has(d) || isAppImageMount(d)) continue;
    seen.add(d);
    out.push(d);
  }
  return out.join(":");
}

// the graphical session's variables a relaunch carries over
export const SESSION_VARS = [
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
  "XDG_CURRENT_DESKTOP",
  "XDG_SESSION_TYPE",
  "XDG_SESSION_DESKTOP",
  "DESKTOP_SESSION",
  "KDE_FULL_SESSION",
  "KDE_SESSION_VERSION",
  "XAUTHORITY",
  "ELECTRON_OZONE_PLATFORM_HINT",
  "CK_PACKAGE_ROOT",
  "HOME",
  "LANG",
  "PATH",
];

export function relaunchEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  // loop: NOT-WORTH — a fixed list of 16 names
  for (const v of SESSION_VARS) {
    const value = env[v];
    if (!value) continue;
    out[v] = v === "PATH" ? cleanPathList(value) : value;
  }
  if (out.PATH === "") delete out.PATH;
  return out;
}

// the flags this copy was started with (--no-sandbox…), never Chromium's own per-process switches
export function relaunchArgs(argv: string[]): string[] {
  // loop: NOT-WORTH — the command line, once per relaunch
  return argv.slice(1).filter((a) => typeof a === "string" && !/^--type=/.test(a));
}

// `systemd-run` arguments: a transient user service, gone when it ends (--collect). ExitType=cgroup as
// KDE's own launcher sets it: the unit lasts until its last process is gone, so the AppImage's FUSE helper
// unmounts by itself after the app quits instead of being killed with the mount in place. systemd older
// than 250 refuses ExitType: then KillMode=process (DS5's fallback).
export function systemdRunArgs(o: { target: string; args?: string[]; env?: Record<string, string>; unit: string; exitTypeCgroup?: boolean }): string[] {
  // loop: NOT-WORTH — a few environment variables, once per relaunch
  const setenv = Object.entries(o.env ?? {}).map(([k, v]) => `--setenv=${k}=${v}`);
  return ["--user", "--collect", `--unit=${o.unit}`, "-p", o.exitTypeCgroup === false ? "KillMode=process" : "ExitType=cgroup", ...setenv, "--", o.target, ...(o.args ?? [])];
}

// No systemd: a detached shell that waits for us to go, then becomes the new copy.
// The target and flags go as arguments ("$0" "$@"), never pasted into the script.
export function shellArgs(target: string, args: string[] = []): string[] {
  return ["-c", 'sleep 0.5; exec "$0" "$@"', target, ...args];
}
