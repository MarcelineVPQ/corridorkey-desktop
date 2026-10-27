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
  "HOME",
  "LANG",
  "PATH",
];

export function relaunchEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  // loop: NOT-WORTH — a fixed list of 15 names
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

// No systemd: a detached shell that waits for this copy to be gone, then becomes the new copy.
// Measured with tools/update_e2e.sh (2026-10-22), two faults of the old "sleep 0.5; exec":
//  - Node's spawn passes on every descriptor without close-on-exec, and one is this AppImage
//    runtime's keepalive pipe: the new copy held the old mount up for its whole life (the old
//    runtime blocked in anon_pipe_write; the new copy's fd 3 -> the old runtime's pipe), with the
//    old copy's Chromium pipes beside it. So the shell closes every descriptor above stderr first
//    (bash: dash, /bin/sh on Debian/Ubuntu, can't name descriptors above 9).
//  - 0.5 s is shorter than a quit: the new copy started while the old one still ran (its DevTools
//    port still bound: "bind() failed: Address already in use"; both on one profile). So it waits
//    for this process to end, at most WAIT_OLD_S (the old copy's own exit fallback is 10 s).
// The pid, target and flags go as arguments, never pasted into the script.
export const WAIT_OLD_S = 15;
export const FALLBACK_SCRIPT = [
  "p=$1; shift",
  'if [ -n "$BASH_VERSION" ]; then for f in /proc/$$/fd/*; do n=${f##*/}; [ "$n" -gt 2 ] 2>/dev/null && eval "exec $n>&-" 2>/dev/null; done; fi',
  `end=$(($(date +%s) + ${WAIT_OLD_S}))`,
  'while kill -0 "$p" 2>/dev/null && [ "$(date +%s)" -lt "$end" ]; do sleep 0.1; done',
  'exec "$@"',
].join("; ");
export function shellArgs(oldPid: number, target: string, args: string[] = []): string[] {
  return ["-c", FALLBACK_SCRIPT, "corridorkey-relaunch", String(oldPid), target, ...args];
}

/** The fallback's program: bash when there is one (it closes the inherited descriptors), else sh. */
export function fallbackShell(exists: (p: string) => boolean): string {
  // loop: NOT-WORTH — two paths, once per restart
  return ["/bin/bash", "/usr/bin/bash"].find(exists) ?? "/bin/sh";
}

// `systemd-run` arguments: a transient user service, gone when it ends (--collect). ExitType=cgroup as
// KDE's own launcher sets it: the unit lasts until its last process is gone, so the AppImage's FUSE helper
// unmounts by itself after the app quits instead of being killed with the mount in place. systemd older
// than 250 refuses ExitType: then KillMode=process (DS5's fallback).
// The unit runs the fallback's own wait (FALLBACK_SCRIPT through `shell`), not the target itself: systemd
// starts the unit at once, while this copy still quits (bug hunt 2026-10 U6, backlog row 16), so the new copy
// starts only once this process is gone (at most WAIT_OLD_S). The descriptor close in it is a no-op there
// (systemd hands a service none of ours).
export function systemdRunArgs(o: { target: string; args?: string[]; env?: Record<string, string>; unit: string; exitTypeCgroup?: boolean; oldPid: number; shell: string }): string[] {
  // loop: NOT-WORTH — a few environment variables, once per relaunch
  const setenv = Object.entries(o.env ?? {}).map(([k, v]) => `--setenv=${k}=${v}`);
  const kill = o.exitTypeCgroup === false ? "KillMode=process" : "ExitType=cgroup";
  return ["--user", "--collect", `--unit=${o.unit}`, "-p", kill, ...setenv, "--", o.shell, ...shellArgs(o.oldPid, o.target, o.args ?? [])];
}
