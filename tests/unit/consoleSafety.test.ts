// The Console's safety pieces (docs/CONSOLE.md): the file scope, the elevation, the append-only audit log, the history.
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  allowLine,
  allowVerdict,
  checkWrite,
  expandHome,
  fsErrorText,
  isInside,
  realPathDeps,
  resolveReal,
  serverNotAllowed,
  systemFolders,
  uncServer,
  type PathDeps,
} from "../../electron/main/console/paths";
import { dropOnLockAndSleep, Elevation, ELEVATION_CAP_MS, ELEVATION_TTL_MS } from "../../electron/main/console/elevation";
import { AuditLog, History } from "../../electron/main/console/logs";

// a temp folder of its own: never / or $HOME
// its real path: on macOS the temp folder /var/… is /private/var/…, and the policy compares real paths
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "ck-console-test-")));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const real = realPathDeps("/home/u");

describe("path policy (real files)", () => {
  const out = join(tmp, "out");
  const elsewhere = join(tmp, "elsewhere");
  mkdirSync(join(out, "sh010"), { recursive: true });
  mkdirSync(elsewhere, { recursive: true });
  // a link inside the chosen folder pointing out of it, and one outside pointing in
  symlinkSync(elsewhere, join(out, "escape"));
  symlinkSync(out, join(tmp, "into-out"));

  it("allows a write inside a chosen folder, the folder itself, and a path that doesn't exist yet", async () => {
    expect(await checkWrite("sh010", out, [out], real)).toEqual({ ok: true, path: join(out, "sh010") });
    expect((await checkWrite(out, tmp, [out], real)).ok).toBe(true);
    expect(await checkWrite("new/deeper/key.####.exr", out, [out], real)).toEqual({ ok: true, path: join(out, "new", "deeper", "key.####.exr") });
  });

  it("refuses a symlink that escapes the chosen folder, also through a missing tail", async () => {
    const r = await checkWrite("escape/x.exr", out, [out], real);
    expect(r).toMatchObject({ ok: false, path: join(elsewhere, "x.exr") });
    expect(!r.ok && r.reason).toMatch(/outside the folders the Console may write to/);
    expect((await checkWrite("escape/missing/x.exr", out, [out], real)).ok).toBe(false);
  });

  it("refuses .. out of the chosen folder, and allows a link from outside that leads into it", async () => {
    expect((await checkWrite("sh010/../../elsewhere", out, [out], real)).ok).toBe(false);
    expect((await checkWrite("../out-sibling", out, [out], real)).ok).toBe(false);
    expect(await checkWrite(join(tmp, "into-out", "sh010"), "/", [out], real)).toEqual({ ok: true, path: join(out, "sh010") });
  });

  it("resolves a chosen folder given through a link", async () => {
    expect((await checkWrite(join(out, "sh010"), "/", [join(tmp, "into-out")], real)).ok).toBe(true);
  });

  it("says when no folder is chosen yet", async () => {
    const r = await checkWrite("x", out, [], real);
    expect(!r.ok && r.reason).toMatch(/none is chosen yet/);
  });

  it("ends every refusal with the allow line to type (SME review M1)", async () => {
    // a file: its folder; a folder typed with a slash: itself; a missing tail: the nearest folder that exists
    const file = await checkWrite(join(elsewhere, "r.json"), out, [out], real);
    expect(!file.ok && file.reason.endsWith(`type: allow "${elsewhere}"`)).toBe(true);
    const typedDir = await checkWrite(`${elsewhere}/`, out, [out], real);
    expect(!typedDir.ok && typedDir.reason.endsWith(`allow "${elsewhere}"`)).toBe(true);
    const missing = await checkWrite(join(elsewhere, "a", "b", "k.####.exr"), out, [], real);
    expect(!missing.ok && missing.reason.endsWith(`allow "${elsewhere}"`)).toBe(true);
    expect(allowLine('/m/a "b"\\c', "linux")).toBe('allow "/m/a \\"b\\"\\\\c"');
    expect(allowLine("D:\\show", "win32")).toBe('allow "D:\\show"');
  });

  it("resolves a missing path through its nearest existing parent", async () => {
    expect(await resolveReal("a/b/c", join(tmp, "into-out"), real)).toBe(join(out, "a", "b", "c"));
  });
});

describe("path policy (logic, Windows and macOS rules)", () => {
  // a fake file system: these folders exist, links map one path to another
  const fake = (platform: NodeJS.Platform, have: string[], links: Record<string, string> = {}): PathDeps => ({
    platform,
    home: platform === "win32" ? "C:\\Users\\M" : "/Users/m",
    realpath: async (p) => {
      // loop: NOT-WORTH — a few fake links
      for (const [from, to] of Object.entries(links)) if (p.toLowerCase().startsWith(from.toLowerCase())) return to + p.slice(from.length);
      // loop: NOT-WORTH — a few fake folders
      if (have.some((h) => h.toLowerCase() === p.toLowerCase())) return have.find((h) => h.toLowerCase() === p.toLowerCase())!;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
  });

  it("compares Windows paths without case, with backslashes and drive letters", async () => {
    const d = fake("win32", ["C:\\Shots\\Out", "C:\\Shots", "C:\\", "D:\\"]);
    expect(await checkWrite("c:\\shots\\out\\sh010\\key.####.exr", "C:\\", ["C:\\Shots\\Out"], d)).toEqual({ ok: true, path: "C:\\Shots\\Out\\sh010\\key.####.exr" });
    expect((await checkWrite("C:\\Shots\\OutSide", "C:\\", ["C:\\Shots\\Out"], d)).ok).toBe(false);
    expect((await checkWrite("D:\\out", "C:\\", ["C:\\Shots\\Out"], d)).ok).toBe(false);
    expect((await checkWrite("..\\..\\Windows", "C:\\Shots\\Out", ["C:\\Shots\\Out"], d)).ok).toBe(false);
    expect(isInside("C:\\SHOTS\\OUT\\a", "c:\\shots\\out", "win32")).toBe(true);
    expect(isInside("C:\\SHOTS\\OUT\\a", "c:\\shots\\out", "linux")).toBe(false);
  });

  it("follows a Windows junction out of the folder", async () => {
    const d = fake("win32", ["C:\\Shots\\Out", "E:\\Elsewhere"], { "C:\\Shots\\Out\\link": "E:\\Elsewhere" });
    expect(await checkWrite("C:\\Shots\\Out\\link\\x", "C:\\", ["C:\\Shots\\Out"], d)).toMatchObject({ ok: false, path: "E:\\Elsewhere\\x" });
  });

  it("compares without case on macOS, with case on Linux", () => {
    expect(isInside("/Users/m/OUT/a", "/Users/m/out", "darwin")).toBe(true);
    expect(isInside("/home/m/OUT/a", "/home/m/out", "linux")).toBe(false);
    expect(isInside("/home/m/out..x", "/home/m/out", "linux")).toBe(false);
    expect(isInside("/home/m/out/..x", "/home/m/out", "linux")).toBe(true);
  });

  it("P9 (N3, BACKLOG row 108): on a case-sensitive volume a missing results/new is not inside Results; the names realpath returned still fold", async () => {
    const d: PathDeps = {
      platform: "darwin",
      home: "/Users/m",
      // a case-sensitive volume: only the exact names exist
      realpath: async (p) => {
        if (["/vol", "/vol/Results"].includes(p)) return p;
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
    };
    expect(await checkWrite("/vol/results/new", "/", ["/vol/Results"], d)).toMatchObject({ ok: false, path: "/vol/results/new" });
    expect(await checkWrite("/vol/Results/new", "/", ["/vol/Results"], d)).toEqual({ ok: true, path: "/vol/Results/new" });
    // a case-insensitive volume: realpath answers for any case (here as typed), so the names it returned compare without case
    const ci: PathDeps = { ...d, realpath: async (p) => (p.toLowerCase() === "/vol/results" || p === "/vol" ? p : Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))) };
    expect(await checkWrite("/vol/results/new", "/", ["/VOL/Results"], ci)).toEqual({ ok: true, path: "/vol/results/new" });
  });

  it("expands ~ only at the start", () => {
    expect(expandHome("~/shots", { home: "/home/u", platform: "linux" })).toBe("/home/u/shots");
    expect(expandHome("~", { home: "/home/u", platform: "linux" })).toBe("/home/u");
    expect(expandHome("a/~/b", { home: "/home/u", platform: "linux" })).toBe("a/~/b");
    expect(expandHome("~\\shots", { home: "C:\\Users\\M", platform: "win32" })).toBe("C:\\Users\\M\\shots");
  });

  it("refuses a path it can't resolve (no permission), saying why", async () => {
    const d: PathDeps = { platform: "linux", home: "/h", realpath: async () => Promise.reject(Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })) };
    const r = await checkWrite("/x/y", "/", ["/x"], d);
    expect(!r.ok && r.reason).toMatch(/can't be checked: you have no permission to open/);
  });
});

describe("allow's refusals and warning (backlog row 136, Marcy 2026-10-27)", () => {
  it("Linux: the root and the system folders (and inside them) refused, home warned, a folder inside home and /run/media fine", () => {
    const sys = systemFolders("linux", {});
    // loop: NOT-WORTH — a few folders
    for (const d of ["/", "/etc", "/usr", "/usr/local/share", "/var/lib/x", "/lib64", "/libx32", "/boot", "/root", "/run/user/1000", "/proc", "/sys"])
      expect(allowVerdict(d, "/home/m", sys, "linux"), d).toBe("refuse");
    expect(allowVerdict("/home/m", "/home/m", sys, "linux")).toBe("home");
    expect(allowVerdict("/home/m/shows", "/home/m", sys, "linux")).toBe("ok");
    expect(allowVerdict("/mnt/show/sq01", "/home/m", sys, "linux")).toBe("ok");
    expect(allowVerdict("/run/media/m/drive/show", "/home/m", sys, "linux")).toBe("ok");
    expect(allowVerdict("/home", "/home/m", sys, "linux")).toBe("ok");
    // home below a system folder (Fedora Silverblue's /var/home): home and inside it as anywhere else
    expect(allowVerdict("/var/home/m", "/var/home/m", sys, "linux")).toBe("home");
    expect(allowVerdict("/var/home/m/shots", "/var/home/m", sys, "linux")).toBe("ok");
    // the caller adds the realpaths: merged /usr's /bin → /usr/bin is inside /usr anyway; a made-up one counts
    expect(allowVerdict("/sysroot/x", "/home/m", [...sys, "/sysroot"], "linux")).toBe("refuse");
  });

  it("macOS: /System, /Library, /usr, /private/etc, /private/var refused (any case), ~/Library and /Volumes fine", () => {
    const sys = systemFolders("darwin", {});
    // loop: NOT-WORTH — a few folders
    for (const d of ["/", "/System/Library", "/Library/Preferences", "/usr/local", "/bin", "/sbin", "/private/etc", "/private/var/folders/x", "/LIBRARY"])
      expect(allowVerdict(d, "/Users/m", sys, "darwin"), d).toBe("refuse");
    expect(allowVerdict("/users/M", "/Users/m", sys, "darwin")).toBe("home");
    expect(allowVerdict("/Users/m/Library/show", "/Users/m", sys, "darwin")).toBe("ok");
    expect(allowVerdict("/Volumes/Show/sq01", "/Users/m", sys, "darwin")).toBe("ok");
  });

  it("Windows: every drive's root, %SystemRoot%, %ProgramFiles%, %ProgramFiles(x86)%, %ProgramData% refused (any case)", () => {
    const env = { SystemRoot: "C:\\Windows", ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)", ProgramData: "C:\\ProgramData", TEMP: "relative" };
    const sys = systemFolders("win32", env);
    expect(sys).toEqual(["C:\\Windows", "C:\\Program Files", "C:\\Program Files (x86)", "C:\\ProgramData"]);
    // loop: NOT-WORTH — a few folders
    for (const d of ["C:\\", "D:\\", "c:\\windows\\system32", "C:\\Program Files\\x", "C:\\Program Files (x86)", "C:\\ProgramData\\y", "\\\\nas\\show\\"])
      expect(allowVerdict(d, "C:\\Users\\M", sys, "win32"), d).toBe("refuse");
    expect(allowVerdict("c:\\users\\m", "C:\\Users\\M", sys, "win32")).toBe("home");
    expect(allowVerdict("C:\\Users\\M\\shots", "C:\\Users\\M", sys, "win32")).toBe("ok");
    expect(allowVerdict("D:\\show\\sq01", "C:\\Users\\M", sys, "win32")).toBe("ok");
    expect(allowVerdict("\\\\nas\\show\\sq01", "C:\\Users\\M", sys, "win32")).toBe("ok");
    // a variable not set, or not absolute: not a folder to refuse
    expect(systemFolders("win32", { SystemRoot: "C:\\Windows", ProgramData: "x" })).toEqual(["C:\\Windows"]);
  });
});

describe("network servers on Windows (backlog row 139, Marcy 2026-10-27)", () => {
  it("names the server a path opens: \\\\host, //host, \\\\?\\UNC\\host, a device path; never a drive or Linux/macOS", () => {
    expect(uncServer("\\\\NAS\\show\\a.exr", "win32")).toBe("nas");
    expect(uncServer("//nas/show", "win32")).toBe("nas");
    expect(uncServer("\\\\10.0.0.5\\s", "win32")).toBe("10.0.0.5");
    expect(uncServer("\\\\?\\UNC\\nas\\show", "win32")).toBe("nas");
    expect(uncServer("\\\\.\\UNC\\Nas\\show", "win32")).toBe("nas");
    expect(uncServer("\\\\.\\pipe\\x", "win32")).toBe("pipe");
    expect(uncServer("\\\\?\\GLOBALROOT\\Device\\Mup\\nas", "win32")).toBe("globalroot");
    expect(uncServer("\\\\?\\C:\\shots", "win32")).toBeNull();
    expect(uncServer("C:\\shots", "win32")).toBeNull();
    expect(uncServer("\\shots", "win32")).toBeNull();
    expect(uncServer("//nas/show", "linux")).toBeNull();
    expect(uncServer("//nas/show", "darwin")).toBeNull();
  });

  it("the refusal says what to type", () => {
    expect(fsErrorText(serverNotAllowed("nas"), "\\\\nas\\show")).toMatch(/^\\\\nas\\show is on the network server nas, .*type: allow-server nas$/);
  });
});

describe("elevation", () => {
  it("lasts the TTL, is extended by each elevated command, never past the cap", () => {
    let t = 1_000_000;
    const e = new Elevation(() => t);
    expect([e.active, e.expiresAt]).toEqual([false, null]);
    e.grant();
    expect(e.expiresAt).toBe(t + ELEVATION_TTL_MS);
    t += ELEVATION_TTL_MS - 1;
    expect(e.active).toBe(true);
    e.extend();
    expect(e.expiresAt).toBe(t + ELEVATION_TTL_MS);
    // keep extending: capped at the grant + 15 minutes
    // loop: NOT-WORTH — a few steps of a test clock
    for (let i = 0; i < 5; i++) {
      t += ELEVATION_TTL_MS - 1;
      e.extend();
    }
    expect(e.active).toBe(false);
  });

  it("caps at 15 minutes after the confirmation", () => {
    let t = 0;
    const e = new Elevation(() => t);
    e.grant();
    // loop: NOT-WORTH — a command every 4 minutes
    for (t = 4 * 60_000; t <= 12 * 60_000; t += 4 * 60_000) e.extend();
    t = 14 * 60_000;
    expect(e.expiresAt).toBe(ELEVATION_CAP_MS);
    t = ELEVATION_CAP_MS;
    expect(e.active).toBe(false);
  });

  it("expires by itself and is dropped by sudo -k / a screen lock / quit", () => {
    let t = 0;
    const e = new Elevation(() => t);
    e.grant();
    t = ELEVATION_TTL_MS;
    expect(e.active).toBe(false);
    e.extend();
    expect(e.active).toBe(false);
    e.grant();
    expect(e.drop()).toBe(true);
    expect([e.active, e.drop()]).toEqual([false, false]);
  });

  it("is never persisted: a new session (a restart) starts unelevated", () => {
    const e = new Elevation();
    e.grant();
    expect(new Elevation().active).toBe(false);
    // it has nothing to save: no file, only memory
    expect(Object.keys(e).sort()).toEqual(["grantedAt", "now", "until"]);
  });
});

describe("audit log", () => {
  it("only appends: what is there stays, entries go after it in order", async () => {
    const f = join(tmp, "console-audit.jsonl");
    writeFileSync(f, '{"time":"old","event":"granted"}\n');
    const log = new AuditLog(f);
    await Promise.all([log.append({ event: "run", argv: ["render", "a"], targets: ["/o"] }), log.append({ event: "exit", argv: ["render", "a"], exit: 0 })]);
    const lines = readFileSync(f, "utf8").trim().split("\n");
    expect(lines[0]).toBe('{"time":"old","event":"granted"}');
    expect(lines.slice(1).map((l) => JSON.parse(l).event)).toEqual(["run", "exit"]);
    expect((await log.tail(2)).map((e) => e.event)).toEqual(["run", "exit"]);
    expect(await new AuditLog(join(tmp, "none.jsonl")).tail(5)).toEqual([]);
  });

  it("says whether an entry was written (an elevated command runs only when it was)", async () => {
    expect(await new AuditLog(join(tmp, "console-audit-2.jsonl")).append({ event: "dropped", reason: "test" })).toBe(true);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await new AuditLog(join(tmp, "no-such-folder", "a.jsonl")).append({ event: "dropped", reason: "test" })).toBe(false);
    err.mockRestore();
  });

  it("never opens the log except to append (the source has no write, truncate or rename of it)", () => {
    const src = readFileSync(join(__dirname, "../../electron/main/console/logs.ts"), "utf8");
    const audit = src.slice(src.indexOf("export class AuditLog"), src.indexOf("function parseLines"));
    expect(audit).toMatch(/appendFile\(this\.file, line, \{ flag: "a" \}\)/);
    expect(audit).toMatch(/open\(this\.file, "r"\)/);
    expect(audit).not.toMatch(/writeFile|truncate|rename|rm\(|unlink|"w"|"w\+"|"r\+"/);
  });
});

describe("history", () => {
  it("keeps typed lines across restarts, newest first in a search, consecutive duplicates once", async () => {
    const f = join(tmp, "console-history.jsonl");
    const h = new History(f);
    // loop: NOT-WORTH — a few lines
    for (const l of ["dir", "render a.mov -o out", "render a.mov -o out", "", "cd shots", "dir"]) await h.add(l);
    expect(h.recent(10)).toEqual(["dir", "render a.mov -o out", "cd shots", "dir"]);
    const again = new History(f);
    await again.loaded;
    expect(again.search("RENDER")).toEqual(["render a.mov -o out"]);
    expect(again.search("")).toEqual(["dir", "cd shots", "render a.mov -o out", "dir"]);
  });

  it("numbers each line for good, keeps its folder and end, and skips a line typed with a leading space (SME S6)", async () => {
    const f = join(tmp, "numbered.jsonl");
    // an older file: lines without numbers count from 1
    writeFileSync(f, JSON.stringify({ time: "2026-10-01T10:00:00.000Z", line: "dir" }) + "\n");
    const h = new History(f, 4);
    expect(await h.add("pwd", "/shots")).toBe(2);
    expect(await h.add(" secret line", "/shots")).toBeNull();
    expect(await h.add("pwd", "/shots")).toBe(2);
    await h.ended(2, 0, "done");
    // loop: NOT-WORTH — eight lines, past the cap: compacted
    for (let i = 0; i < 8; i++) await h.add(`render ${i}`, "/x");
    await h.ended(10, 4, "failed");
    const again = new History(f, 4);
    await again.loaded;
    // loop: NOT-WORTH — four entries
    expect(again.last(4).map((e) => [e.n, e.line, e.exit, e.state])).toEqual([
      [7, "render 4", null, null],
      [8, "render 5", null, null],
      [9, "render 6", null, null],
      [10, "render 7", 4, "failed"],
    ]);
    expect(await again.add("next")).toBe(11);
    expect(readFileSync(f, "utf8")).not.toMatch(/secret/);
  });

  it("is capped, and compacts the file when it grows past the cap", async () => {
    const f = join(tmp, "capped.jsonl");
    const h = new History(f, 10);
    // loop: NOT-WORTH — 25 lines
    for (let i = 0; i < 25; i++) await h.add(`line ${i}`);
    expect(h.recent(100)).toEqual(Array.from({ length: 10 }, (_, i) => `line ${i + 15}`));
    const lines = readFileSync(f, "utf8").trim().split("\n").length;
    expect(lines).toBeLessThanOrEqual(11);
    const again = new History(f, 10);
    await again.loaded;
    expect(again.recent(100)).toEqual(h.recent(100));
  });
});

describe("SME review 2026-10-26: elevation and the look-dev loop (M2)", () => {
  it("drops on a screen lock and on sleep, never on a window's blur (Alt+Tab to Nuke and back keeps it)", () => {
    const monitor = new EventEmitter();
    const why: string[] = [];
    dropOnLockAndSleep(monitor, (r) => why.push(r));
    monitor.emit("blur");
    monitor.emit("unlock-screen");
    expect(why).toEqual([]);
    monitor.emit("lock-screen");
    monitor.emit("suspend");
    expect(why).toEqual(["the screen was locked", "the computer went to sleep"]);
  });

  it("the app wires it to Electron's powerMonitor, and the window's blur drops nothing", () => {
    const main = readFileSync(new URL("../../electron/main/index.ts", import.meta.url), "utf8");
    expect(main).toMatch(/dropOnLockAndSleep\(powerMonitor,/);
    expect(main).not.toMatch(/on\("blur"[^\n]*dropElevation/);
  });
});
