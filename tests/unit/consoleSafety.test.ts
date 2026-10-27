// The Console's safety pieces (docs/CONSOLE.md): the file scope, the elevation, the append-only audit log, the history.
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { allowLine, checkWrite, expandHome, isInside, realPathDeps, resolveReal, type PathDeps } from "../../electron/main/console/paths";
import { dropOnLockAndSleep, Elevation, ELEVATION_CAP_MS, ELEVATION_TTL_MS } from "../../electron/main/console/elevation";
import { AuditLog, History } from "../../electron/main/console/logs";

// a temp folder of its own: never / or $HOME
const tmp = mkdtempSync(join(tmpdir(), "ck-console-test-"));
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

  it("P9 (N3, BACKLOG row 108, open): macOS folds case by platform, so on a case-sensitive volume a missing results/new passes inside Results", async () => {
    // pins today's behaviour of an open NICE item (review 2026-10-26): flip when the row is built
    const d: PathDeps = {
      platform: "darwin",
      home: "/Users/m",
      // a case-sensitive volume: only the exact names exist
      realpath: async (p) => {
        if (["/vol", "/vol/Results"].includes(p)) return p;
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
    };
    expect(await checkWrite("/vol/results/new", "/", ["/vol/Results"], d)).toEqual({ ok: true, path: "/vol/results/new" });
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
    expect(!r.ok && r.reason).toMatch(/can't be checked: EACCES/);
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
