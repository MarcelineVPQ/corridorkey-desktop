// The Console's runner with a fake spawn (as engine.test.ts): the exact argv, never a shell, cancel semantics, the CLI's
// JSON events into blocks, the file scope and the sudo flow end to end. Real files only in a temp folder of its own.
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clipName, Console, type ConsoleDeps, type ElevationRequest, type ScriptElevationRequest } from "../../electron/main/console/runner";
import { dropOnLockAndSleep, Elevation } from "../../electron/main/console/elevation";
import { AuditLog, History } from "../../electron/main/console/logs";
import { BlockPusher, PUSH_EVERY_MS } from "../../electron/main/console/push";
import { consoleLineArg, consoleLinesArg, cursorArg, fromAppPage } from "../../electron/main/validate";
import { makeRegistry } from "../../src/shared/console/registry";
import type { ConsoleBlock } from "../../src/shared/types";

const root = realpathSync(mkdtempSync(join(tmpdir(), "ck-console-run-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const out = join(root, "out");
const elsewhere = join(root, "elsewhere");
const shots = join(root, "my shots");
mkdirSync(join(out, "sh010"), { recursive: true });
mkdirSync(elsewhere);
mkdirSync(shots);
writeFileSync(join(shots, "shot.mov"), "x");
writeFileSync(join(shots, "plate 10.exr"), "x");
writeFileSync(join(shots, "plate 9.exr"), "x");
writeFileSync(join(out, "sh010", "key.1001.exr"), "12345");
writeFileSync(join(out, "sh010", "key.1002.exr"), "12345");
symlinkSync(elsewhere, join(out, "escape"));
writeFileSync(join(root, "job-out.json"), JSON.stringify({ input: "a.mov", output_dir: elsewhere }));
writeFileSync(join(root, "job-in.json"), JSON.stringify({ input: "a.mov", output_dir: join(out, "j") }));

interface FakeChild extends ChildProcess {
  signals: (string | undefined)[];
}
function fakeChild(pid = 4242): FakeChild {
  const c = new EventEmitter() as FakeChild;
  c.signals = [];
  Object.assign(c, { stdout: new PassThrough(), stderr: new PassThrough(), pid, kill: (s?: string) => (c.signals.push(s), true) });
  return c;
}
/** The child prints these lines, then exits with `code` (closing its streams first, as a process does). */
async function finish(c: FakeChild, stdout: string[], code: number | null, stderr: string[] = []) {
  // loop: NOT-WORTH — a few test lines
  for (const l of stdout) (c.stdout as PassThrough).write(l + "\n");
  // loop: NOT-WORTH — as above
  for (const l of stderr) (c.stderr as PassThrough).write(l + "\n");
  (c.stdout as PassThrough).end();
  (c.stderr as PassThrough).end();
  await new Promise((r) => setTimeout(r, 5));
  c.emit("close", code, null);
  await new Promise((r) => setTimeout(r, 5));
}

let spawned: { cmd: string; args: string[]; opts: SpawnOptions; child: FakeChild }[];
let confirms: ElevationRequest[];
let confirmAnswer: boolean;
let scriptAsks: ScriptElevationRequest[];
let gpuTaken: number;
let gpuReleased: number;
let gpuRefusal: string | null;
let killed: number[];
let t: number;
let blocks: Map<number, ConsoleBlock>;
let cli: string | null;
let runtimeOk: boolean;
let allowedFolders: string[];
let allowAsked: string[];
let allowAnswer: boolean;
let shown: string[];

function make(over: Partial<ConsoleDeps> = {}, files = mkdtempSync(join(root, "user-"))) {
  const deps: ConsoleDeps = {
    registry: makeRegistry(),
    paths: { realpath: (p) => import("node:fs/promises").then((f) => f.realpath(p)), platform: "linux", home: root },
    fs: {
      readdir: (p) => readdir(p, { withFileTypes: true }),
      stat: (p) => stat(p),
      readFile: (p) => readFile(p, "utf8"),
      mkdir: async (p) => void (await mkdir(p, { recursive: true })),
    },
    startDir: shots,
    cli: () => cli,
    cliEnv: () => ({ CK_TEST: "1" }),
    cliTemp: () => join(out, ".console-temp"),
    runtimeAllowed: (_w, p) => runtimeOk || p === "/models/listed",
    writeRoots: () => [out, ...allowedFolders],
    allowed: () => allowedFolders,
    setAllowed: (f) => void (allowedFolders = f),
    confirmAllow: async (f) => (allowAsked.push(f), allowAnswer),
    showInFolder: (p) => void shown.push(p),
    takeGpu: () => {
      if (gpuRefusal) return gpuRefusal;
      gpuTaken++;
      return null;
    },
    releaseGpu: () => void gpuReleased++,
    confirm: async (r) => (confirms.push(r), confirmAnswer),
    confirmScript: async (r) => (scriptAsks.push(r), confirmAnswer),
    elevation: new Elevation(() => t),
    audit: new AuditLog(join(files, "console-audit.jsonl")),
    history: new History(join(files, "console-history.jsonl")),
    changed: (b) => void blocks.set(b.id, structuredClone(b)),
    sessionChanged: () => {},
    spawn: (cmd, args, opts) => {
      const child = fakeChild();
      spawned.push({ cmd, args, opts, child });
      return child;
    },
    killTree: (pid) => void killed.push(pid),
    now: () => t,
    version: "1.0.0-dev.9",
    ...over,
  };
  return { c: new Console(deps), deps, files };
}

beforeEach(() => {
  spawned = [];
  confirms = [];
  confirmAnswer = true;
  scriptAsks = [];
  allowedFolders = [];
  allowAsked = [];
  allowAnswer = true;
  shown = [];
  gpuTaken = 0;
  gpuReleased = 0;
  gpuRefusal = null;
  killed = [];
  t = 1_000_000;
  blocks = new Map();
  cli = "/app/resources/engine/corridorkey";
  runtimeOk = false;
});

describe("corridorkey from the Console", () => {
  it("runs the fixed binary with an exact argv: no shell, own process group, JSON progress, temp in the app's cache", async () => {
    const { c } = make();
    const b = await c.run("render shot.mov -o ../out/sh010 -F 1001-1100 --linear");
    expect(b.state).toBe("running");
    expect(spawned).toHaveLength(1);
    const s = spawned[0];
    expect(s.cmd).toBe("/app/resources/engine/corridorkey");
    expect(s.args).toEqual(["render", "--temp", join(out, ".console-temp"), "--progress-format", "json", "--output", join(out, "sh010"), "--frames", "1001-1100", "--linear", "--", "shot.mov"]);
    expect(s.opts).toMatchObject({ cwd: shots, shell: false, detached: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { CK_TEST: "1" } });
    expect(b.argv).toEqual(s.args);
    expect(gpuTaken).toBe(1);
    await finish(s.child, [], 0);
  });

  it("turns the CLI's JSON events into the block's progress and phase; other lines are output", async () => {
    const { c } = make();
    const b = await c.run("render shot.mov -o ../out/a");
    const s = spawned[0];
    (s.child.stdout as PassThrough).write('{"event":"status","text":"loading the models"}\n{"event":"progress","percent":45,"done":45,"total":100}\nplain line\n');
    await new Promise((r) => setTimeout(r, 5));
    expect(blocks.get(b.id)).toMatchObject({ status: "loading the models", progress: { percent: 45, done: 45, total: 100 }, state: "running" });
    await finish(s.child, [], 0, ["keying window 1/2"]);
    const end = blocks.get(b.id)!;
    expect(end).toMatchObject({ state: "done", exitCode: 0, exitMeaning: "done" });
    expect(end.lines).toEqual([
      { kind: "out", text: "plain line" },
      { kind: "err", text: "keying window 1/2" },
    ]);
    expect(gpuReleased).toBe(1);
    expect(c.session().running).toBeNull();
  });

  it("says why a run failed: the fail event and the exit code's meaning", async () => {
    const { c } = make();
    const b = await c.run("render shot.mov -o ../out/a");
    await finish(spawned[0].child, ['{"event":"fail","exit_code":6,"reason":"out-of-graphics-memory","message":"no memory"}'], 6);
    expect(blocks.get(b.id)).toMatchObject({ state: "failed", exitCode: 6, exitMeaning: expect.stringMatching(/out of graphics memory/) });
    expect(blocks.get(b.id)!.lines.at(-1)).toEqual({ kind: "err", text: "failed: no memory (out-of-graphics-memory)" });
  });

  it("cancels with SIGTERM (a clean stop, 143), and a second cancel kills the process group", async () => {
    const { c } = make();
    const b = await c.run("render shot.mov -o ../out/a");
    c.cancel();
    expect(spawned[0].child.signals).toEqual(["SIGTERM"]);
    expect(killed).toEqual([]);
    c.cancel();
    expect(killed).toEqual([4242]);
    await finish(spawned[0].child, [], 143);
    expect(blocks.get(b.id)).toMatchObject({ state: "cancelled", exitCode: 143, exitMeaning: "stopped, cleanly" });
  });

  it("on Windows the first cancel ends the tree (no SIGTERM there)", async () => {
    const { c } = make({ paths: { realpath: async (p) => p, platform: "win32", home: "C:\\Users\\M" }, startDir: "C:\\shots", writeRoots: () => ["C:\\out"] });
    await c.run("render shot.mov -o C:\\out\\a");
    expect(spawned[0].opts.detached).toBe(false);
    c.cancel();
    expect([spawned[0].child.signals, killed]).toEqual([[], [4242]]);
    await finish(spawned[0].child, [], 1);
  });

  it("runs one job at a time; built-ins still answer meanwhile", async () => {
    const { c } = make();
    await c.run("render shot.mov -o ../out/a");
    const second = await c.run("verify shot.mov -o ../out/a");
    expect(second.state).toBe("refused");
    expect(second.lines[0].text).toMatch(/Busy with render shot.mov/);
    expect((await c.run("pwd")).lines[0].text).toBe(shots);
    expect(spawned).toHaveLength(1);
    await finish(spawned[0].child, [], 0);
  });

  it("is refused while the queue has the graphics card; info and verify don't need it", async () => {
    gpuRefusal = "The queue is keying on the graphics card: wait for it, or stop it, then run this.";
    const { c } = make();
    const b = await c.run("render shot.mov -o ../out/a");
    expect([b.state, b.lines[0].text]).toEqual(["refused", gpuRefusal]);
    await c.run("info --json");
    expect(spawned.map((s) => s.args)).toEqual([["info", "--json"]]);
    await finish(spawned[0].child, [], 0);
  });

  it("refuses a write outside the chosen folders, also through a symlink, and never spawns", async () => {
    const { c } = make();
    // loop: NOT-WORTH — four lines
    for (const l of [
      `render shot.mov -o ${elsewhere}`,
      "render shot.mov -o ../out/escape/x",
      "render shot.mov -o ../out/sh010/../../elsewhere",
      `render shot.mov -o ../out/a --report ${join(elsewhere, "r.json")}`,
    ]) {
      const b = await c.run(l);
      expect(b.state, l).toBe("refused");
      expect(b.lines.map((x) => x.text).join(" "), l).toMatch(/outside the folders the Console may write to/);
    }
    expect(spawned).toEqual([]);
  });

  it("SME M1: a refusal ends with the exact allow line; allow asks, remembers, audits, and the write then runs", async () => {
    const { c, files } = make();
    const show = join(elsewhere, "show");
    mkdirSync(join(show, "sq01"), { recursive: true });
    const refused = await c.run(`render shot.mov -o ${join(show, "sq01", "v003")}/key.####.exr`);
    expect(refused.state).toBe("refused");
    // the nearest folder that exists above the missing v003/
    expect(refused.lines[0].text.endsWith(`type: allow "${join(show, "sq01")}"`)).toBe(true);
    // cancelled: nothing allowed, nothing audited
    allowAnswer = false;
    expect((await c.run(`allow "${show}"`)).state).toBe("refused");
    expect([allowAsked, allowedFolders]).toEqual([[show], []]);
    allowAnswer = true;
    const ok = await c.run(`trust ${show}`);
    expect([ok.state, allowedFolders]).toEqual(["done", [show]]);
    expect(JSON.parse(readFileSync(join(files, "console-audit.jsonl"), "utf8").trim())).toMatchObject({ event: "allowed", targets: [show] });
    // a folder inside it: no second dialog, nothing added
    expect((await c.run(`allow ${join(show, "sq01")}`)).lines[0].text).toMatch(/may already write/);
    expect(allowAsked).toHaveLength(2);
    expect((await c.run("allow")).lines.map((l) => l.text)).toEqual(["The Console may also write in (App settings → Console removes them):", `  ${show}`]);
    await c.run(`render shot.mov -o ${join(show, "sq01", "v003")}/key.####.exr`);
    expect(spawned).toHaveLength(1);
    await finish(spawned[0].child, [], 0);
    // removed (App settings): no confirmation, audited, and the write is refused again
    expect(await c.disallow(show)).toBe(true);
    expect(await c.disallow(show)).toBe(false);
    expect(allowedFolders).toEqual([]);
    expect(readFileSync(join(files, "console-audit.jsonl"), "utf8")).toMatch(/"event":"removed"/);
    expect((await c.run(`render shot.mov -o ${join(show, "sq01")}/k.####.exr`)).state).toBe("refused");
  });

  it("SME M1: allow takes only a folder that exists", async () => {
    const { c } = make();
    expect((await c.run(`allow "${join(shots, "shot.mov")}"`)).lines[0].text).toMatch(/isn't a folder/);
    expect((await c.run(`allow ${join(elsewhere, "nope")}`)).state).toBe("failed");
    expect(allowAsked).toEqual([]);
  });

  it("checks a --job file's own output folder", async () => {
    const { c } = make();
    const bad = await c.run(`render --job ${join(root, "job-out.json")}`);
    expect([bad.state, bad.lines[0].text]).toEqual(["refused", expect.stringMatching(/--job's output_dir: .*outside/)]);
    // -o given: the flag wins over the file
    await c.run(`render --job ${join(root, "job-out.json")} -o ../out/b`);
    await finish(spawned[0].child, [], 0);
    await c.run(`render --job ${join(root, "job-in.json")}`);
    expect(spawned).toHaveLength(2);
    await finish(spawned[1].child, [], 0);
  });

  it("runs only the runtime and models the Engine page lists", async () => {
    const { c } = make();
    const b = await c.run("info --ort /tmp/evil.so");
    expect([b.state, b.lines[0].text]).toEqual(["refused", expect.stringMatching(/only the ONNX Runtime the Engine page lists/)]);
    await c.run("info --models /models/listed");
    expect(spawned[0].args).toEqual(["info", "--models", "/models/listed"]);
    await finish(spawned[0].child, [], 0);
  });

  it("says so when the command line isn't shipped", async () => {
    cli = null;
    const { c } = make();
    expect((await c.run("info")).lines[0].text).toMatch(/isn't part of this copy/);
    expect(c.session().cliFound).toBe(false);
  });

  it("refuses a line with mistakes, with their positions", async () => {
    const { c } = make();
    const b = await c.run("render shot.mov --frame 1001");
    expect(b.state).toBe("refused");
    expect(b.errors).toEqual([{ message: "corridorkey render has no option --frame (did you mean --frames?)", start: 16, end: 23 }]);
  });
});

describe("sudo", () => {
  it("refuses a destructive flag without sudo", async () => {
    const { c } = make();
    const b = await c.run("render shot.mov -o ../out/sh010 --overwrite");
    expect([b.state, b.lines[0].text]).toEqual(["refused", "--overwrite replaces files that are already there: run it as sudo render shot.mov -o ../out/sh010 --overwrite"]);
    expect(confirms).toEqual([]);
  });

  it("asks once with the exact command and its targets, then stays elevated (extended), all audited", async () => {
    const { c, files } = make();
    const b = await c.run("sudo render shot.mov -o ../out/sh010 --overwrite");
    expect(confirms).toHaveLength(1);
    expect(confirms[0].line).toBe("sudo render shot.mov -o ../out/sh010 --overwrite");
    expect(confirms[0].command).toBe(`sudo corridorkey render --output ${join(out, "sh010")} --overwrite -- shot.mov`);
    // its key.* frames aren't at this run's names (shot_…): nothing there is replaced
    expect(confirms[0].targets).toEqual([{ path: join(out, "sh010"), files: 0, bytes: 0 }]);
    expect([b.elevated, c.session().elevatedUntil]).toEqual([true, t + 5 * 60_000]);
    await finish(spawned[0].child, [], 0);
    t += 60_000;
    const again = await c.run("sudo render shot.mov -o ../out/sh010 --overwrite");
    expect(confirms).toHaveLength(1);
    expect([again.elevated, c.session().elevatedUntil]).toEqual([true, t + 5 * 60_000]);
    await finish(spawned[1].child, [], 0);
    const audit = readFileSync(join(files, "console-audit.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(audit.map((e) => e.event)).toEqual(["granted", "run", "exit", "run", "exit"]);
    expect(audit[0].targets).toEqual([join(out, "sh010")]);
    expect(audit[2].exit).toBe(0);
  });

  it("counts a frame pattern's frames in its folder", async () => {
    const { c } = make();
    await c.run("sudo render shot.mov -o ../out/sh010/key.####.exr --overwrite");
    expect(confirms[0].targets).toEqual([{ path: join(out, "sh010", "key.####.exr"), files: 2, bytes: 10 }]);
    await finish(spawned[0].child, [], 0);
  });

  it("runs nothing when the confirmation is cancelled", async () => {
    confirmAnswer = false;
    const { c, files } = make();
    const b = await c.run("sudo render shot.mov -o ../out/sh010 --overwrite");
    expect([b.state, b.elevated, spawned.length, c.session().elevatedUntil]).toEqual(["refused", false, 0, null]);
    await new Promise((r) => setTimeout(r, 5));
    expect(JSON.parse(readFileSync(join(files, "console-audit.jsonl"), "utf8")).event).toBe("refused");
  });

  it("never asks for a command the file scope refuses anyway", async () => {
    const { c } = make();
    expect((await c.run(`sudo render shot.mov -o ${elsewhere} --overwrite`)).state).toBe("refused");
    expect(confirms).toEqual([]);
  });

  it("is dropped by sudo -k and by a screen lock (audited), and asks again after", async () => {
    const { c, files } = make();
    await c.run("sudo render shot.mov -o ../out/sh010 --overwrite");
    await finish(spawned[0].child, [], 0);
    expect((await c.run("sudo -k")).lines[0].text).toBe("Not elevated.");
    expect(c.session().elevatedUntil).toBeNull();
    await c.run("sudo render shot.mov -o ../out/sh010 --overwrite");
    expect(confirms).toHaveLength(2);
    await finish(spawned[1].child, [], 0);
    const monitor = new EventEmitter();
    dropOnLockAndSleep(monitor, (why) => c.dropElevation(why));
    monitor.emit("lock-screen");
    await new Promise((r) => setTimeout(r, 5));
    const events = readFileSync(join(files, "console-audit.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    // loop: NOT-WORTH — a few entries
    expect(events.filter((e) => e.event === "dropped").map((e) => e.reason)).toEqual(["sudo -k", "the screen was locked"]);
  });

  it("runs a non-destructive command under sudo as usual, without asking", async () => {
    const { c } = make();
    const b = await c.run("sudo pwd");
    expect([b.state, b.elevated, confirms.length]).toEqual(["done", false, 0]);
  });
});

describe("built-ins", () => {
  it("cd / pwd keep the Console's own folder; cd alone goes home; a missing folder is said", async () => {
    const { c } = make();
    // silent on success (SME S9): the bar and the prompt show the folder
    const up = await c.run("cd ..");
    expect([up.state, up.lines]).toEqual(["done", []]);
    expect(c.session().cwd).toBe(root);
    expect((await c.run("cd 'my shots'")).state).toBe("done");
    expect((await c.run("pwd")).lines[0].text).toBe(shots);
    expect((await c.run("cd nowhere")).state).toBe("failed");
    expect((await c.run("cd shot.mov")).lines[0].text).toMatch(/isn't a folder/);
    await c.run("cd");
    expect(c.session().cwd).toBe(root);
  });

  it("dir / ls list with sizes and dates, in natural order", async () => {
    const { c } = make();
    const b = await c.run("ls");
    expect(b.entries!.map((e) => [e.name, e.folder, e.bytes])).toEqual([
      ["plate 9.exr", false, 1],
      ["plate 10.exr", false, 1],
      ["shot.mov", false, 1],
    ]);
    expect(b.entries![0].modified).toBeGreaterThan(0);
    expect(b.lines[0].text).toMatch(/3 files \(3 B\), 0 folders/);
    expect((await c.run("dir ..")).entries!.some((e) => e.name === "out" && e.folder)).toBe(true);
  });

  it("help, <command> ?, help -k, apropos", async () => {
    const { c } = make();
    expect((await c.run("help")).lines.map((l) => l.text).join("\n")).toMatch(/render .*uses the graphics card/);
    const h = (await c.run("render ?")).lines.map((l) => l.text);
    expect(h[0]).toBe("usage: corridorkey render [OPTIONS] [INPUT]");
    expect(h.join("\n")).toMatch(/--overwrite .*\(needs sudo\)/);
    expect(h.join("\n")).toMatch(/-o, --output DIR\|PATTERN .*\(only into chosen folders\)/);
    expect(h).not.toContain(expect.stringMatching(/progress-format/));
    expect((await c.run("help ls")).lines[0].text).toBe("usage: dir [OPTIONS] [FOLDER]");
    expect((await c.run("help -k overwrite")).lines.map((l) => l.text).join("\n")).toMatch(/corridorkey render --overwrite/);
    expect((await c.run("apropos overwrite")).lines.map((l) => l.text).join("\n")).toMatch(/corridorkey render --overwrite/);
    expect((await c.run("apropos zzzz")).lines[0].text).toMatch(/Nothing matches/);
    const f = await c.run("find . -name x.exr");
    expect([f.state, f.lines[0].text]).toEqual(["refused", expect.stringMatching(/help -k <term>/)]);
  });

  it("cls clears; history lists what was typed; history --audit the elevated log", async () => {
    const { c } = make();
    expect((await c.run("cls")).clear).toBe(true);
    await c.run("pwd");
    await new Promise((r) => setTimeout(r, 5));
    expect((await c.run("history")).lines.map((l) => l.text)).toEqual([
      expect.stringMatching(new RegExp(`^   1  \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d  ✓    cls   \\[${shots}\\]$`)),
      expect.stringMatching(/^   2  .*  ✓    pwd   \[/),
    ]);
    expect((await c.run("history --audit")).lines[0].text).toBe("Nothing elevated yet.");
    // loop: NOT-WORTH — one entry
    expect(c.history("PW").map((e) => e.line)).toEqual(["pwd"]);
  });

  it("SME S6: history N and history <term>, stable numbers, the exit code kept, a leading space not kept", async () => {
    const { c, files } = make();
    // loop: NOT-WORTH — four lines
    for (const l of ["pwd", "cd nowhere", " cd ..", "dir"]) await c.run(l);
    await new Promise((r) => setTimeout(r, 10));
    const text = async (l: string) => (await c.run(l)).lines.map((x) => x.text);
    // the line with a leading space isn't kept (it still ran: cd .. moved up)
    const all = await text("history 10");
    expect(all.map((t) => t.split(/\s+/)[1])).toEqual(["1", "2", "3"]);
    expect(all[1]).toMatch(/✗\s+cd nowhere/);
    expect(await text("history 1")).toEqual([expect.stringMatching(/^ +4 .*history 10/)]);
    expect(await text("history nowhere")).toEqual([expect.stringMatching(/^ +2 .*✗\s+cd nowhere/)]);
    // the folder is searched too, and kept across a restart with its number and end
    await new Promise((r) => setTimeout(r, 10));
    const again = new History(join(files, "console-history.jsonl"));
    await again.loaded;
    // loop: NOT-WORTH — a few entries
    expect(again.entries("cd nowhere").map((e) => [e.n, e.state, e.cwd])).toEqual([[2, "failed", shots]]);
    expect(again.entries(root).length).toBeGreaterThanOrEqual(4);
  });
});

describe("run <script>", () => {
  it("runs each line through the same checks, in order, and stops at the first failure", async () => {
    const { c } = make();
    writeFileSync(join(shots, "a.ckcmd"), "# a comment\n\ncd ..\npwd\ncd nowhere\npwd\n");
    const b = await c.run("run a.ckcmd");
    await new Promise((r) => setTimeout(r, 20));
    const end = blocks.get(b.id)!;
    expect(end.state).toBe("failed");
    expect(end.lines.map((l) => l.text)).toEqual(["a.ckcmd:3  cd ..", "a.ckcmd:4  pwd", "a.ckcmd:5  cd nowhere", "stopped at line 5: failed"]);
    // loop: NOT-WORTH — the script's blocks
    const children = [...blocks.values()].filter((x) => x.parent === b.id);
    expect(children.map((x) => [x.line, x.state])).toEqual([
      ["cd ..", "done"],
      ["pwd", "done"],
      ["cd nowhere", "failed"],
    ]);
  });

  it("waits for each corridorkey line, refuses a nested script and other jobs meanwhile", async () => {
    const { c } = make();
    writeFileSync(join(shots, "b.ckcmd"), "render shot.mov -o ../out/a\nrun b.ckcmd\n");
    const b = await c.run("run b.ckcmd");
    await new Promise((r) => setTimeout(r, 10));
    expect(spawned).toHaveLength(1);
    expect((await c.run("info")).state).toBe("refused");
    await finish(spawned[0].child, [], 0);
    await new Promise((r) => setTimeout(r, 10));
    expect(blocks.get(b.id)!.state).toBe("failed");
    // loop: NOT-WORTH — the script's blocks
    expect([...blocks.values()].find((x) => x.line === "run b.ckcmd" && x.parent === b.id)!.lines[0].text).toBe("A script can't run another script.");
  });

  it("stops the script on cancel", async () => {
    const { c } = make();
    writeFileSync(join(shots, "c.ckcmd"), "render shot.mov -o ../out/a\npwd\n");
    const b = await c.run("run c.ckcmd");
    await new Promise((r) => setTimeout(r, 10));
    c.cancel();
    expect(spawned[0].child.signals).toEqual(["SIGTERM"]);
    await finish(spawned[0].child, [], 143);
    await new Promise((r) => setTimeout(r, 10));
    expect(blocks.get(b.id)!.state).toBe("cancelled");
    // loop: NOT-WORTH — the script's blocks
    expect([...blocks.values()].some((x) => x.parent === b.id && x.line === "pwd")).toBe(false);
  });
});

describe("quit", () => {
  it("stops a running corridorkey: SIGTERM, then the group is killed after the grace", async () => {
    const { c } = make();
    await c.run("render shot.mov -o ../out/a");
    const quit = c.shutdown(20);
    expect(spawned[0].child.signals).toEqual(["SIGTERM"]);
    await quit;
    expect(killed).toEqual([4242]);
  });

  it("resolves at once when the run stops cleanly", async () => {
    const { c } = make();
    await c.run("render shot.mov -o ../out/a");
    const quit = c.shutdown(10_000);
    spawned[0].child.emit("exit", 143, null);
    await quit;
    expect(killed).toEqual([]);
  });
});

describe("completion", () => {
  const items = async (c: Console, line: string, cursor = line.length) => (await c.complete(line, cursor)).items.map((i) => i.insert);

  it("completes commands, subcommands, flags and enum values from the registry", async () => {
    const { c } = make();
    expect(await items(c, "re")).toEqual(["render"]);
    expect(await items(c, "sudo cl")).toEqual(["clear", "cls"]);
    expect(await items(c, "corridorkey v")).toEqual(["verify"]);
    expect(await items(c, "render --ove")).toEqual(["--overwrite"]);
    expect(await items(c, "render --format ")).toEqual(["exr", "video"]);
    expect(await items(c, "render --format=v")).toEqual(["--format=video"]);
    expect(await items(c, "help ren")).toEqual(["render"]);
    // a flag already given isn't offered again; --progress-format never
    expect(await items(c, "render -o x --out")).toEqual(["--output-colorspace", "--outputs"]);
    expect(await items(c, "render --progress")).toEqual([]);
  });

  it("completes paths (folders end with /, names with spaces quoted), relative to the Console's folder", async () => {
    const { c } = make();
    await c.run("cd ..");
    expect(await items(c, "cd my")).toEqual(['"my shots/"']);
    expect(await items(c, "render my\\ shots/pl")).toEqual(['"my shots/plate 9.exr"', '"my shots/plate 10.exr"']);
    expect(await items(c, "render shot.mov -o o")).toEqual(["out/"]);
    const r = await c.complete("render x -o o", 13);
    expect([r.start, r.end]).toEqual([12, 13]);
  });

  it("completes at the cursor, not the line's end", async () => {
    const { c } = make();
    const r = await c.complete("ren shot.mov", 3);
    expect([r.start, r.end, r.items.map((i) => i.insert)]).toEqual([0, 3, ["render"]]);
  });
});

describe("block pushes and IPC checks", () => {
  it("coalesces block updates to one send per 100 ms, only while shown", async () => {
    vi.useFakeTimers();
    try {
      const sent: number[][] = [];
      const p = new BlockPusher((bs) => sent.push(bs.map((b) => b.id)));
      const b = (id: number) => ({ id }) as ConsoleBlock;
      p.mark(b(1));
      vi.advanceTimersByTime(PUSH_EVERY_MS * 3);
      expect(sent).toEqual([]);
      p.setShown(true);
      p.mark(b(1));
      p.mark(b(2));
      p.mark(b(1));
      vi.advanceTimersByTime(PUSH_EVERY_MS);
      expect(sent).toEqual([[1, 2]]);
      p.mark(b(3));
      p.setShown(false);
      vi.advanceTimersByTime(PUSH_EVERY_MS);
      expect(sent).toHaveLength(1);
      p.setShown(true);
      vi.advanceTimersByTime(PUSH_EVERY_MS);
      expect(sent).toEqual([[1, 2], [3]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("accepts only the app page's top frame, and checked arguments", () => {
    const mainFrame = {};
    const wc = { mainFrame };
    expect(fromAppPage({ sender: wc, senderFrame: mainFrame }, wc)).toBe(true);
    expect(fromAppPage({ sender: wc, senderFrame: {} }, wc)).toBe(false);
    expect(fromAppPage({ sender: {}, senderFrame: mainFrame }, wc)).toBe(false);
    expect(fromAppPage({ sender: wc, senderFrame: null }, wc)).toBe(false);
    expect(fromAppPage({ sender: wc, senderFrame: mainFrame }, null)).toBe(false);
    expect([consoleLineArg("pwd", 10), consoleLineArg("x".repeat(11), 10), consoleLineArg("a\0b", 10), consoleLineArg(5, 10)]).toEqual(["pwd", null, null, null]);
    expect([cursorArg(3, "pwd"), cursorArg(4, "pwd"), cursorArg(-1, "pwd"), cursorArg(1.5, "pwd")]).toEqual([3, null, null, null]);
  });
});

// The senior review of 2026-10-26 (docs/REVIEW_CONSOLE_2026-10-26.md): each probe, inverted, as a regression test.
describe("review 2026-10-26 probes", () => {
  const win = (over: Partial<ConsoleDeps> = {}) =>
    make({ paths: { realpath: async (p) => p, platform: "win32", home: "C:\\Users\\M" }, startDir: "D:\\shots", writeRoots: () => ["D:\\results"], ...over });

  it("P1 (M1): a URL-looking written path is checked like any other (Linux)", async () => {
    const { c } = make();
    const b = await c.run("render shot.mov -o x://y/");
    expect(b.state).toBe("refused");
    expect(b.lines[0].text).toMatch(/^--output: .*outside the folders/);
    expect(spawned).toEqual([]);
  });

  it("P1 (M1): C://… is a path on Windows, checked for every written flag", async () => {
    const { c } = win();
    const b = await c.run("render shot.mov -o C://Users/Public/anywhere/ --report C://Windows/Temp/r.json");
    expect(b.state).toBe("refused");
    expect(b.lines.map((l) => l.text)).toEqual([expect.stringMatching(/^--output: C:\\Users\\Public\\anywhere.* outside/), expect.stringMatching(/^--report: C:\\Windows\\Temp\\r\.json.* outside/)]);
    expect(spawned).toEqual([]);
  });

  it("P1 (M1): sudo with a URL-looking output is refused before any dialog; only --ocio's ocio:// names pass as names", async () => {
    const { c } = make();
    expect((await c.run("sudo render shot.mov -o x://y/ --overwrite")).state).toBe("refused");
    expect((await c.run("render shot.mov -o ocio://studio/")).state).toBe("refused");
    expect(confirms).toEqual([]);
    expect(spawned).toEqual([]);
    await c.run("render shot.mov -o ../out/a --ocio ocio://studio-config-latest");
    expect(spawned[0].args).toContain("ocio://studio-config-latest");
    await finish(spawned[0].child, [], 0);
  });

  it("P2 (M2): a --job file the app can't fully read or parse is refused, not passed on unchecked", async () => {
    const big = join(root, "job-big.json");
    writeFileSync(big, JSON.stringify({ input: "a.mov", output_dir: elsewhere }) + " ".repeat(1024 * 1024));
    writeFileSync(join(root, "job-bad.json"), "{ not json");
    // index.ts's reader: regular files of at most `max` bytes
    const { c } = make({
      fs: {
        readdir: (p) => readdir(p, { withFileTypes: true }),
        stat: (p) => stat(p),
        readFile: async (p, max) => {
          if ((await stat(p)).size > max) throw new Error(`larger than ${max} bytes`);
          return readFile(p, "utf8");
        },
        mkdir: async (p) => void (await mkdir(p, { recursive: true })),
      },
    });
    // loop: NOT-WORTH — three job files
    for (const f of [big, join(root, "job-bad.json"), join(root, "job-missing.json")]) {
      const b = await c.run(`render --job ${f}`);
      expect([b.state, b.lines[0].text], f).toEqual(["refused", expect.stringMatching(/^--job: can't check/)]);
    }
    expect(spawned).toEqual([]);
  });

  it("P2 (M2): the job's checked folders are passed as resolved --output and --temp (flags win over the file)", async () => {
    const f = join(root, "job-temp.json");
    writeFileSync(f, JSON.stringify({ input: "a.mov", output_dir: "../out/j", temp_dir: join(out, "jt") }));
    const { c } = make();
    await c.run(`render --job ${f}`);
    expect(spawned[0].args).toEqual(["render", "--progress-format", "json", "--job", f, "--output", join(out, "j"), "--temp", join(out, "jt")]);
    // the file changing after the check changes nothing: the CLI is given what was checked
    writeFileSync(f, JSON.stringify({ input: "a.mov", output_dir: elsewhere }));
    expect(spawned[0].args).toContain(join(out, "j"));
    await finish(spawned[0].child, [], 0);
  });

  it("P3 (M3): render --skip-existing (which re-keys a whole set that isn't complete) runs only as sudo, confirmed and audited", async () => {
    const { c } = make();
    const b = await c.run("render shot.mov -o ../out/ --skip-existing");
    expect([b.state, b.lines[0].text]).toEqual(["refused", expect.stringMatching(/^--skip-existing replaces files that are already there: run it as sudo/)]);
    expect(spawned).toEqual([]);
    const s = await c.run("sudo render shot.mov -o ../out/ --skip-existing");
    expect([s.elevated, confirms.length, spawned.length]).toEqual([true, 1, 1]);
    await finish(spawned[0].child, [], 0);
  });

  it("P5 (M4): on Windows, without an injected killTree, cancel, a second cancel and quit end the tree with taskkill", async () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      const { c } = win({ killTree: undefined });
      await c.run("render shot.mov -o D:\\results\\a");
      c.cancel();
      c.cancel();
      // the quit: its own cancel, then the grace's kill
      await c.shutdown(10);
      const taskkill = spawned.slice(1);
      expect(taskkill.map((s) => [s.cmd, s.args, s.opts.shell])).toEqual(Array(4).fill(["C:\\Windows\\System32\\taskkill.exe", ["/pid", "4242", "/T", "/F"], false]));
      expect(kill).not.toHaveBeenCalled();
      await finish(spawned[0].child, [], 1);
    } finally {
      kill.mockRestore();
    }
  });

  it("P4 (S1): a run script and a command can't both take the one job slot", async () => {
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    writeFileSync(join(shots, "s.ckcmd"), "pwd\n");
    const { c } = make({
      fs: {
        readdir: (p) => readdir(p, { withFileTypes: true }),
        stat: (p) => stat(p),
        // a slow disk: the script's file arrives after the render has been typed
        readFile: async (p) => (await slow, readFile(p, "utf8")),
        mkdir: async (p) => void (await mkdir(p, { recursive: true })),
      },
    });
    const script = c.run("run s.ckcmd");
    const render = await c.run("render shot.mov -o ../out/a/");
    expect([render.state, render.lines[0].text]).toEqual(["refused", expect.stringMatching(/^Busy with run s.ckcmd/)]);
    release();
    await script;
    await new Promise((r) => setTimeout(r, 10));
    expect(spawned).toEqual([]);
    expect(c.session().running).toBeNull();
  });

  it("P11 (S2): a command still in its checks when the app quits never starts", async () => {
    const { c } = make();
    const pending = c.run("render shot.mov -o ../out/q/");
    await c.shutdown(50);
    const b = await pending;
    expect([b.state, b.lines[0]?.text]).toEqual(["refused", "Not run: the app is quitting."]);
    expect(spawned).toEqual([]);
    expect(gpuTaken).toBe(0);
  });

  it("P6 (S4): an elevated command doesn't run when the audit log can't record it", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { c } = make({ audit: new AuditLog(join(root, "no-such-folder", "console-audit.jsonl")) });
      const b = await c.run("sudo render shot.mov -o ../out/z/ --overwrite");
      expect([b.state, b.elevated, b.lines[0].text]).toEqual(["refused", false, expect.stringMatching(/^Not run: the audit log couldn't record it/)]);
      expect([spawned.length, c.session().elevatedUntil]).toEqual([0, null]);
    } finally {
      err.mockRestore();
    }
  });

  it("P6 (S4): already elevated, the run entry is written before the spawn; unwritable, nothing runs", async () => {
    let writable = true;
    const entries: string[] = [];
    const audit = { append: async (e: { event: string }) => (writable && entries.push(e.event), writable), tail: async () => [] } as unknown as AuditLog;
    const { c } = make({ audit });
    await c.run("sudo render shot.mov -o ../out/sh010 --overwrite");
    expect(entries).toEqual(["granted", "run"]);
    await finish(spawned[0].child, [], 0);
    expect(entries).toEqual(["granted", "run", "exit"]);
    writable = false;
    const b = await c.run("sudo render shot.mov -o ../out/sh010 --overwrite");
    expect([b.state, spawned.length]).toEqual(["refused", 1]);
  });

  it("S7: the sudo dialog shows the line as typed and a quoted argv without the Console's own flags, control and bidi characters escaped, and counts only the run's names", async () => {
    const dir = join(out, "s7 out\u202e\nfake line");
    mkdirSync(join(dir, "shot_alpha_exr"), { recursive: true });
    mkdirSync(join(dir, "other_alpha_exr"), { recursive: true });
    writeFileSync(join(dir, "shot_alpha_exr", "shot_alpha.1001.exr"), "123");
    writeFileSync(join(dir, "shot_alpha_exr", "shot_alpha.1002.exr"), "123");
    writeFileSync(join(dir, "shot_settings.txt"), "1");
    writeFileSync(join(dir, "other_alpha_exr", "other_alpha.1001.exr"), "123456");
    writeFileSync(join(dir, "notes.txt"), "123456");
    const { c } = make();
    await c.run(`sudo render shot.mov -o '${dir}' --overwrite`);
    const shown = join(out, "s7 out\\u{202e}\\u{a}fake line");
    expect(confirms[0].line).toBe(`sudo render shot.mov -o '${join(out, "s7 out\\u{202e}\\u{a}fake line")}' --overwrite`);
    expect(confirms[0].command).toBe(`sudo corridorkey render --output "${shown}" --overwrite -- shot.mov`);
    expect(confirms[0].targets).toEqual([{ path: shown, files: 3, bytes: 7 }]);
    // loop: NOT-WORTH — the dialog's few strings
    for (const s of [confirms[0].line, confirms[0].command, confirms[0].targets[0].path]) expect(s).not.toMatch(/[\n\u202e]/);
    await finish(spawned[0].child, [], 0);
  });

  it("S7: names the clip as corridorkey does (ck-core clip.rs raw_clip_name's cases)", () => {
    expect(["/clips/shot.mp4", "/clips/shot01/rgb/", "/clips/shot01/Frames", "/clips/a.b.mov", "/clips/.hidden"].map((p) => clipName(p, "linux"))).toEqual([
      "shot",
      "shot01",
      "shot01",
      "a.b",
      ".hidden",
    ]);
    expect(clipName("D:\\plates\\sh010\\input", "win32")).toBe("sh010");
  });

  // P7 and P8 pin today's behaviour of two open NICE items: flip each when its backlog row is built
  it("P7 (N1, BACKLOG row 106, open): a value starting with - goes to the CLI as two words (clap then refuses it, exit 2)", async () => {
    const { c } = make();
    await c.run("render shot.mov -o ../out/c/ --codec=-x");
    expect(spawned[0].args).toEqual(expect.arrayContaining(["--codec", "-x"]));
    expect(spawned[0].args).not.toContain("--codec=-x");
    await finish(spawned[0].child, [], 2);
  });

  it("P8 (N2, BACKLOG row 107, built by SME S11): sudo on a command that replaces nothing runs it normally, and says so", async () => {
    const { c } = make();
    const b = await c.run("sudo render shot.mov -o ../out/d/");
    expect([b.state, b.elevated, confirms.length, b.lines.map((l) => l.text)]).toEqual(["running", false, 0, ["sudo isn't needed for this (it replaces no files): ran it as it is."]]);
    await finish(spawned[0].child, [], 0);
  });
});

describe("SME review 2026-10-26", () => {
  it("S7: version, corridorkey --version and render --version answer with the version, without running anything", async () => {
    const { c } = make();
    expect((await c.run("corridorkey --version")).lines.map((l) => l.text)).toEqual(["corridorkey 1.0.0-dev.9"]);
    expect((await c.run("render --version")).lines.map((l) => l.text)).toEqual(["corridorkey-render 1.0.0-dev.9"]);
    expect((await c.run("version")).lines[0].text).toBe("CorridorKey 1.0.0-dev.9 (the app and its corridorkey command line: one version)");
    expect(spawned).toHaveLength(0);
  });
});

describe("SME review 2026-10-26: plain errors (S4) and open (S5)", () => {
  it("built-ins say what is wrong in words, and what to type, never Node's ENOENT text", async () => {
    const { c } = make();
    const cd = await c.run("cd nowhere");
    expect(cd.lines[0].text).toBe(`Can't go to nowhere: ${join(shots, "nowhere")} isn't there. pwd says where you are, dir lists the folders here, Tab completes a name.`);
    const into = await c.run('cd "shot.mov/x"');
    expect(into.lines[0].text).toMatch(/a part of .* is a file, not a folder/);
    const ls = await c.run("ls nowhere");
    expect(ls.lines[0].text).toBe(`Can't list ${join(shots, "nowhere")}: ${join(shots, "nowhere")} isn't there. dir alone lists the current folder; Tab completes a name.`);
    const script = await c.run("run missing.ckcmd");
    expect(script.lines[0].text).toMatch(/^Can't read the script: .*missing\.ckcmd isn't there\./);
    // loop: NOT-WORTH — four blocks
    for (const b of [cd, into, ls, script]) expect(b.lines[0].text).not.toMatch(/ENOENT|ENOTDIR|scandir|stat '/);
  });

  it("open . shows the folder in the file manager (never opens a file); a missing path says so", async () => {
    const { c } = make();
    expect((await c.run("open .")).state).toBe("done");
    expect((await c.run('start "shot.mov"')).state).toBe("done");
    expect(shown).toEqual([shots, join(shots, "shot.mov")]);
    expect((await c.run("open nope")).lines[0].text).toMatch(/^Can't show it: .*nope isn't there/);
    expect(spawned).toEqual([]);
  });
});

describe("SME review 2026-10-26: shell reflexes (M3)", () => {
  /** a folder: big.exr (oldest, 300 B), mid.exr (200 B), new.exr (newest, 10 B), .hidden, sub/ */
  function listing() {
    const d = mkdtempSync(join(root, "ls-"));
    writeFileSync(join(d, "big.exr"), "x".repeat(300));
    writeFileSync(join(d, "mid.exr"), "x".repeat(200));
    writeFileSync(join(d, "new.exr"), "x".repeat(10));
    writeFileSync(join(d, ".hidden"), "x");
    mkdirSync(join(d, "sub"));
    utimesSync(join(d, "big.exr"), 1000, 1000);
    utimesSync(join(d, "mid.exr"), 2000, 2000);
    utimesSync(join(d, "new.exr"), 3000, 3000);
    utimesSync(join(d, "sub"), 1500, 1500);
    return d;
  }
  const names = (b: ConsoleBlock) => b.entries!.map((e) => e.name);

  it("ls / dir take -l -a -t -S -r -1, combined like -la; dot files only with -a", async () => {
    const { c } = make({ startDir: listing() });
    const plain = await c.run("ls");
    expect(names(plain)).toEqual(["big.exr", "mid.exr", "new.exr", "sub"]);
    expect(plain.lines[0].text).toMatch(/1 hidden \(dir -a shows them\)/);
    expect(names(await c.run("ls -la"))).toEqual([".hidden", "big.exr", "mid.exr", "new.exr", "sub"]);
    expect((await c.run("ls -l")).state).toBe("done");
    expect(names(await c.run("ls -t"))).toEqual(["new.exr", "mid.exr", "sub", "big.exr"]);
    expect(names(await c.run("ls -tr"))).toEqual(["big.exr", "sub", "mid.exr", "new.exr"]);
    expect(names(await c.run("ls -S"))).toEqual(["big.exr", "mid.exr", "new.exr", "sub"]);
    expect(names(await c.run("ls -Sr"))).toEqual(["sub", "new.exr", "mid.exr", "big.exr"]);
    const one = await c.run("ls -1");
    expect([one.entries, one.lines.map((l) => l.text)]).toEqual([null, ["big.exr", "mid.exr", "new.exr", "sub/"]]);
    expect((await c.run("ls -1a")).lines.map((l) => l.text)[0]).toBe(".hidden");
  });

  it("dir takes DOS's /w /b /a /o:d on every system", async () => {
    const d = listing();
    const { c } = make({ startDir: d });
    expect((await c.run("dir /w")).lines.map((l) => l.text)).toEqual(["big.exr", "mid.exr", "new.exr", "sub/"]);
    expect((await c.run("dir /b /a")).lines.map((l) => l.text)).toContain(".hidden");
    expect(names(await c.run("dir /a"))).toContain(".hidden");
    expect(names(await c.run("dir /o:d"))).toEqual(["big.exr", "sub", "mid.exr", "new.exr"]);
    expect(names(await c.run("dir /o:-d"))).toEqual(["new.exr", "mid.exr", "sub", "big.exr"]);
    expect(names(await c.run("dir /o:s"))).toEqual(["sub", "new.exr", "mid.exr", "big.exr"]);
    expect(names(await c.run("dir /O:D"))).toEqual(["big.exr", "sub", "mid.exr", "new.exr"]);
    expect(names(await c.run("dir /od"))).toEqual(["big.exr", "sub", "mid.exr", "new.exr"]);
    // a folder named like one is still reachable quoted
    expect((await c.run(`dir "${d}"`)).state).toBe("done");
    expect((await c.run("dir /o:x")).state).toBe("refused");
  });

  it("cd - goes back to the previous folder and says where", async () => {
    const { c } = make();
    const first = await c.run("cd -");
    expect([first.state, first.lines[0].text]).toEqual(["failed", expect.stringMatching(/no previous folder/i)]);
    await c.run("cd ..");
    const back = await c.run("cd -");
    expect([back.state, back.lines.map((l) => l.text), c.session().cwd]).toEqual(["done", [shots], shots]);
    await c.run("cd -");
    expect(c.session().cwd).toBe(root);
  });
});

describe("SME review 2026-10-26: sequences (M4, S1)", () => {
  /** sh010_plate.1001-1012.exr without 1005, sh010_plate.mov, notes.txt, sh010_plates/ */
  function plates() {
    const d = mkdtempSync(join(root, "seq-"));
    // loop: NOT-WORTH — twelve test frames
    for (let f = 1001; f <= 1012; f++) if (f !== 1005) writeFileSync(join(d, `sh010_plate.${f}.exr`), "x".repeat(100));
    writeFileSync(join(d, "sh010_plate.mov"), "x");
    writeFileSync(join(d, "notes.txt"), "x");
    mkdirSync(join(d, "sh010_plates"));
    return d;
  }

  it("M4: Tab offers one pattern per sequence (its frame range in the description), not one item per frame; single files still complete", async () => {
    const { c } = make({ startDir: plates() });
    const r = await c.complete("render sh010_pl", 15);
    expect(r.items.map((i) => [i.insert, i.help])).toEqual([
      ["sh010_plate.####.exr", "frames 1001-1012 (11), missing 1005"],
      ["sh010_plate.mov", ""],
      ["sh010_plates/", ""],
    ]);
    expect((await c.complete("render no", 9)).items.map((i) => i.insert)).toEqual(["notes.txt"]);
    // -o offers the same pattern style
    expect((await c.complete("render x.mov -o sh010_plate.", 28)).items.map((i) => i.insert)).toEqual(["sh010_plate.####.exr", "sh010_plate.mov"]);
  });

  it("S1: dir groups a sequence into one row (range, count, gaps, total size); dir -f lists the frames", async () => {
    const { c } = make({ startDir: plates() });
    const b = await c.run("dir");
    expect(b.entries!.map((e) => [e.name, e.bytes, e.sequence])).toEqual([
      ["notes.txt", 1, null],
      ["sh010_plate.####.exr", 1100, { range: "1001-1012", count: 11, missing: "1005" }],
      ["sh010_plate.mov", 1, null],
      ["sh010_plates", null, null],
    ]);
    expect(b.lines[0].text).toMatch(/13 files \(1.1 KiB\), 11 of them in 1 sequence/);
    const f = await c.run("dir -f");
    expect(f.entries!.filter((e) => e.name.startsWith("sh010_plate.1"))).toHaveLength(11);
    expect((await c.run("ls -1")).lines.map((l) => l.text)).toContain("sh010_plate.####.exr");
  });
});

describe("SME review 2026-10-26: scripts and elevation (S11), pasted lines (S2)", () => {
  const settle = () => new Promise((r) => setTimeout(r, 20));

  it("a script's lines that replace files are listed in one dialog up front; cancelled, nothing runs", async () => {
    const { c, files } = make();
    writeFileSync(join(shots, "d.ckcmd"), "pwd\nsudo render shot.mov -o ../out/e/ --overwrite\nsudo render shot.mov -o ../out/f/ --overwrite\n");
    confirmAnswer = false;
    const b = await c.run("run d.ckcmd");
    expect([b.state, b.lines[0].text]).toEqual(["refused", "Not run: the confirmation was cancelled (nothing ran)."]);
    expect(scriptAsks).toEqual([{ script: "d.ckcmd", lines: ["d.ckcmd:2  sudo render shot.mov -o ../out/e/ --overwrite", "d.ckcmd:3  sudo render shot.mov -o ../out/f/ --overwrite"] }]);
    expect([confirms, spawned, [...blocks.values()].filter((x) => x.parent === b.id)]).toEqual([[], [], []]);
    expect(readFileSync(join(files, "console-audit.jsonl"), "utf8")).toMatch(/"event":"refused","argv":\["run","d.ckcmd"\]/);
    expect(c.session().running).toBeNull();
  });

  it("confirmed: its lines run without a dialog each, and the session is never elevated by it", async () => {
    const { c } = make();
    writeFileSync(join(shots, "e.ckcmd"), "sudo render shot.mov -o ../out/g/ --overwrite\n");
    const b = await c.run("run e.ckcmd");
    await settle();
    expect([scriptAsks.length, confirms.length, spawned.length]).toEqual([1, 0, 1]);
    expect([...blocks.values()].find((x) => x.parent === b.id)!.elevated).toBe(true);
    expect(c.session().elevatedUntil).toBeNull();
    await finish(spawned[0].child, [], 0);
  });

  it("an active elevation is never inherited: the script still asks (backlog 110)", async () => {
    const { c } = make();
    await c.run("sudo render shot.mov -o ../out/h/ --overwrite");
    await finish(spawned[0].child, [], 0);
    expect(c.session().elevatedUntil).not.toBeNull();
    writeFileSync(join(shots, "f.ckcmd"), "sudo render shot.mov -o ../out/i/ --overwrite\n");
    confirmAnswer = false;
    expect((await c.run("run f.ckcmd")).state).toBe("refused");
    expect([scriptAsks.length, spawned.length]).toEqual([1, 1]);
  });

  it("a script line that replaces files without sudo refuses the whole script before anything runs", async () => {
    const { c } = make();
    writeFileSync(join(shots, "g.ckcmd"), "pwd\nrender shot.mov -o ../out/j/ --overwrite\n");
    const b = await c.run("run g.ckcmd");
    expect([b.state, b.lines[0].text]).toEqual(["refused", "g.ckcmd:2 replaces files: a script says so with sudo (sudo render shot.mov -o ../out/j/ --overwrite); nothing ran."]);
    expect([scriptAsks, spawned]).toEqual([[], []]);
  });

  it("pasted lines run as a script: in order, the same checks, stopping at the first that fails", async () => {
    const { c } = make();
    const b = await c.runLines(["cd ..", "cd nowhere", "pwd"]);
    await settle();
    expect(b.line).toBe("cd ..\ncd nowhere\npwd");
    const end = blocks.get(b.id)!;
    expect([end.state, end.lines.map((l) => l.text)]).toEqual(["failed", ["pasted:1  cd ..", "pasted:2  cd nowhere", "stopped at line 2: failed"]]);
    // loop: NOT-WORTH — a few lines
    expect(consoleLinesArg(["pwd"], 100)).toBeNull();
    expect(consoleLinesArg(["pwd", "dir\nrm x"], 100)).toBeNull();
    expect(consoleLinesArg(["pwd", "dir"], 100)).toEqual(["pwd", "dir"]);
  });
});

describe("SME review 2026-10-26: values in any case (S12)", () => {
  it("passes an enum's value to the CLI as the CLI spells it", async () => {
    const { c } = make();
    await c.run("render shot.mov -o ../out/k/ --format EXR --datatype Float");
    expect(spawned[0].args).toEqual(expect.arrayContaining(["--format", "exr", "--datatype", "float"]));
    expect(spawned[0].args).not.toContain("EXR");
    await finish(spawned[0].child, [], 0);
    // Tab completes in any case too
    const r = await c.complete("render a.mov --format EX", 24);
    // loop: NOT-WORTH — one item
    expect(r.items.map((i) => i.insert)).toEqual(["exr"]);
  });
});
