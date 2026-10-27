// The Console's runner with a fake spawn (as engine.test.ts): the exact argv, never a shell, cancel semantics, the CLI's
// JSON events into blocks, the file scope and the sudo flow end to end. Real files only in a temp folder of its own.
import { EventEmitter } from "node:events";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, stat, writeFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { replaceFile } from "../../electron/main/console/paths";
import { clipName, Console, type ConsoleDeps, type ElevationRequest, type ScriptElevationRequest } from "../../electron/main/console/runner";
import { dropOnLockAndSleep, Elevation, LinuxLockWatch, LOCK_POLL_MS, parseLockedHint } from "../../electron/main/console/elevation";
import { AuditLog, History } from "../../electron/main/console/logs";
import { BlockPusher, PUSH_EVERY_MS } from "../../electron/main/console/push";
import { consoleLineArg, consoleLinesArg, cursorArg, fromAppPage } from "../../electron/main/validate";
import { makeRegistry } from "../../src/shared/console/registry";
import { blockText } from "../../src/ui/console/model";
import { DEFAULT_OPTIONS, type ConsoleBlock, type DoctorRow, type Job } from "../../src/shared/types";

const root = realpathSync(mkdtempSync(join(tmpdir(), "ck-console-run-")));
// the last tests' history appends (fire-and-forget, as in the app) land before the folder goes
afterAll(async () => {
  await new Promise((r) => setTimeout(r, 50));
  rmSync(root, { recursive: true, force: true });
});
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

/** index.ts's bounded read */
async function readRange(p: string, start: number, length: number): Promise<Buffer> {
  const fh = await open(p, "r");
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, start);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

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
let queued: readonly Job[];
let marks: Record<string, string>;
let keptVars: Record<string, string>;

function make(over: Partial<ConsoleDeps> = {}, files = mkdtempSync(join(root, "user-"))) {
  const deps: ConsoleDeps = {
    registry: makeRegistry(),
    paths: { realpath: (p) => import("node:fs/promises").then((f) => f.realpath(p)), platform: "linux", home: root },
    fs: {
      readdir: (p) => readdir(p, { withFileTypes: true }),
      stat: (p) => stat(p),
      lstat: (p) => lstat(p),
      readRange,
      readFile: (p) => readFile(p, "utf8"),
      mkdir: async (p) => void (await mkdir(p, { recursive: true })),
      writeFile: replaceFile,
      writable: async () => true,
      freeBytes: async () => 2 ** 40,
    },
    startDir: shots,
    cli: () => cli,
    cliEnv: () => ({ CK_TEST: "1" }),
    cliTemp: () => join(out, ".console-temp"),
    runtimeAllowed: (_w, p) => runtimeOk || p === "/models/listed",
    writeRoots: () => [out, ...allowedFolders],
    allowed: () => allowedFolders,
    setAllowed: (f) => void (allowedFolders = f),
    bookmarks: () => marks,
    setBookmarks: (m) => void (marks = m),
    variables: () => keptVars,
    setVariables: (v) => void (keptVars = v),
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
    jobs: () => queued,
    doctor: () => ({ rows: [], folders: [] }),
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
  queued = [];
  marks = {};
  keptVars = {};
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

  it("verify's missing frames end the block as ranges, as the CLI reports them (ready for -F)", async () => {
    const { c } = make();
    const b = await c.run("verify -i plate.####.exr -o ../out/key.####.exr");
    await finish(
      spawned[0].child,
      [
        "missing or incomplete: /out/key.1012.exr",
        "missing frames: 1012-1015, 1040 (re-render them: -F 1012-1015,1040)",
        '{"event":"fail","exit_code":9,"reason":"incomplete","message":"5 of 100 file(s) missing or incomplete (frames 1012-1015, 1040)"}',
      ],
      9,
    );
    expect(blocks.get(b.id)).toMatchObject({ state: "failed", exitCode: 9, exitMeaning: expect.stringMatching(/missing/) });
    expect(
      blocks
        .get(b.id)!
        .lines.slice(-2)
        .map((l) => l.text),
    ).toEqual(["missing frames: 1012-1015, 1040 (re-render them: -F 1012-1015,1040)", "failed: 5 of 100 file(s) missing or incomplete (frames 1012-1015, 1040) (incomplete)"]);
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
    expect([b.state, b.lines[0].text]).toEqual(["refused", "--overwrite replaces files that are already there: run it as sudo render shot.mov -o ../out/sh010 --overwrite (or type sudo !!)"]);
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

  it("dir / ls list with sizes and dates; plate 9 and plate 10 are one unpadded sequence (lsseq, SME 2026-10-27 M2)", async () => {
    const { c } = make();
    const b = await c.run("ls");
    expect(b.entries!.map((e) => [e.name, e.folder, e.bytes])).toEqual([
      ["plate #.exr", false, 2],
      ["shot.mov", false, 1],
    ]);
    expect(b.entries![0].modified).toBeGreaterThan(0);
    expect(b.lines[0].text).toMatch(/3 files \(3 B\), 2 of them in 1 sequence .*, 0 folders/);
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
    // pwd's end (its ✓) is kept after its line's append: awaited, never a guessed sleep (it flaked under load)
    const files = mkdtempSync(join(root, "user-"));
    const history = new History(join(files, "console-history.jsonl"));
    const ended = history.ended.bind(history);
    let pwdEnded!: () => void;
    const pwdKept = new Promise<void>((r) => (pwdEnded = r));
    history.ended = async (n, exit, state) => {
      await ended(n, exit, state);
      if (n === 2) pwdEnded();
    };
    const { c } = make({ history }, files);
    expect((await c.run("cls")).clear).toBe(true);
    await c.run("pwd");
    await pwdKept;
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
    expect([...blocks.values()].find((x) => x.line === "run b.ckcmd" && x.parent === b.id)!.lines[0].text).toMatch(/^A script can't run another script/);
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
    expect(await items(c, "render my\\ shots/pl")).toEqual(['"my shots/plate #.exr"']);
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
        lstat: (p) => lstat(p),
        readRange,
        readFile: async (p, max) => {
          if ((await stat(p)).size > max) throw new Error(`larger than ${max} bytes`);
          return readFile(p, "utf8");
        },
        mkdir: async (p) => void (await mkdir(p, { recursive: true })),
        writeFile: (p, text) => writeFile(p, text),
        writable: async () => true,
        freeBytes: async () => 2 ** 40,
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
        lstat: (p) => lstat(p),
        readRange,
        // a slow disk: the script's file arrives after the render has been typed
        readFile: async (p) => (await slow, readFile(p, "utf8")),
        mkdir: async (p) => void (await mkdir(p, { recursive: true })),
        writeFile: (p, text) => writeFile(p, text),
        writable: async () => true,
        freeBytes: async () => 2 ** 40,
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

describe("Phase 4: doctor", () => {
  const INFO_OK = {
    corridorkey: "1.0.0",
    onnxruntime: "1.23.0",
    provider: "cuda",
    precision: "fp16",
    unavailable: null,
    gpu: { name: "NVIDIA GeForce RTX 5080", driver: "590.44", vram_total_mb: 16303 },
    tensorrt_available: true,
    // as ck-cli prints it (a real run: ModelSet::assets is a map of the five networks)
    models: { dir: "/m/2.0.0-onnx.4", set: "2.0.0-onnx.4", assets: { cradio: true, moge: true, rvm: true, stage1: true, stage2: true } },
    decoders: { ffmpeg: "7.1" },
  };
  const app = (over: Partial<DoctorRow>[] = []) => ({
    rows: [{ check: "ffmpeg", status: "ok", detail: "ffmpeg 7.1 with libx264 and dnxhd", fix: null } as DoctorRow, ...(over as DoctorRow[])],
    folders: [
      { label: "Results folder", path: out },
      { label: "Cache folder", path: join(root, "no-such-cache") },
    ],
  });
  const fs4 = (free: number, writable = true) => ({
    readdir: (p: string) => readdir(p, { withFileTypes: true }),
    stat: (p: string) => stat(p),
    lstat: (p: string) => lstat(p),
    readRange,
    readFile: (p: string) => readFile(p, "utf8"),
    mkdir: async (p: string) => void (await mkdir(p, { recursive: true })),
    writeFile: (p: string, text: string) => writeFile(p, text),
    writable: async () => writable,
    freeBytes: async () => free,
  });
  /** the CLI's info prints this JSON, then exits with `code` */
  async function answer(json: unknown, code = 0, stderr: string[] = []) {
    await new Promise((r) => setTimeout(r, 5));
    await finish(spawned[0].child, json === null ? [] : JSON.stringify(json, null, 2).split("\n"), code, stderr);
  }

  it("one row per check with ✓ ⚠ ✗; info only (never render or prepare, never the card's slot); exit 0 when nothing fails", async () => {
    const { c } = make({ doctor: () => app(), fs: fs4(500 * 2 ** 30) });
    const p = c.run("doctor");
    await answer(INFO_OK);
    const b = await p;
    expect(spawned[0].args).toEqual(["info", "--json"]);
    expect(spawned[0].opts.shell).toBe(false);
    expect(gpuTaken).toBe(0);
    const text = blockText(b).split("\n");
    expect(text.find((l) => l.includes("Graphics card"))).toMatch(/^✓ Graphics card +NVIDIA GeForce RTX 5080 · driver 590.44 · 15.9 GiB · cuda \(fp16\)$/);
    expect(text.find((l) => l.includes("Models"))).toMatch(/^✓ Models +2.0.0-onnx.4 in \/m\/2.0.0-onnx.4$/);
    expect(text.find((l) => l.includes("Results folder"))).toMatch(/^✓ Results folder .*writable · 500 GiB free/);
    // a folder made when something is written: a warning with what to do, not a failure
    expect(text.find((l) => l.includes("Cache folder"))).toMatch(/^⚠ Cache folder .*isn't there yet/);
    expect([b.state, b.exitCode]).toEqual(["done", 0]);
  });

  it("each problem says its fix; a failure ends the block failed (exit 1)", async () => {
    const { c } = make({
      doctor: () => app([{ check: "TensorRT", status: "warn", detail: "on, but its parts aren't all downloaded: jobs run on CUDA", fix: "App: Engine page → TensorRT → Download" }]),
      fs: fs4(1 * 2 ** 30),
    });
    const p = c.run("doctor");
    await answer({
      ...INFO_OK,
      provider: null,
      gpu: null,
      unavailable: "no NVIDIA driver found",
      models: { dir: "/m", set: null, assets: { cradio: true, moge: true, rvm: false, stage1: true, stage2: false } },
    });
    const b = await p;
    const text = blockText(b).split("\n");
    const at = (s: string) => text.findIndex((l) => l.includes(s));
    expect(text[at("Graphics card")]).toMatch(/^✗ Graphics card +no NVIDIA driver found$/);
    expect(text[at("Graphics card") + 1]).toMatch(/^ +fix: /);
    expect(text[at("Models")]).toMatch(/^✗ Models +\/m has no rvm, stage2 networks$/);
    expect(text[at("Models") + 1]).toMatch(/fix: App: Engine page → Runtime and models \(download the models\)/);
    expect(text[at("TensorRT") + 1]).toMatch(/fix: App: Engine page → TensorRT → Download/);
    expect(text[at("Results folder")]).toMatch(/^✗ Results folder .*1.0 GiB free/);
    expect([b.state, b.exitCode]).toEqual(["failed", 1]);
  });

  it("no corridorkey, or an info that fails, is a row of its own; --json prints the rows as JSON", async () => {
    cli = null;
    const { c } = make({ doctor: () => app(), fs: fs4(500 * 2 ** 30) });
    const b = await c.run("doctor --json");
    const rows = JSON.parse(b.lines.map((l) => l.text).join("\n")) as DoctorRow[];
    expect(rows[0]).toMatchObject({ check: "corridorkey", status: "fail" });
    expect(rows.map((r) => r.check)).toContain("ffmpeg");
    expect(spawned).toEqual([]);
    cli = "/app/resources/engine/corridorkey";
    const p = c.run("doctor");
    await answer(null, 7, ["ERROR: ONNX Runtime didn't load: libonnxruntime.so: not found (--ort LIB, or CK_ENGINE_ORT) (exit 7, assets)"]);
    const f = await p;
    expect(
      blockText(f)
        .split("\n")
        .find((l) => l.includes("ONNX Runtime")),
    ).toMatch(/^✗ ONNX Runtime +ONNX Runtime didn't load: libonnxruntime.so: not found/);
    // every row is output, a ✓ one too, though the block failed
    expect(f.lines.every((l) => l.kind === "out")).toBe(true);
    // a model set info can't open is the Models row
    const p2 = c.run("doctor");
    await new Promise((r) => setTimeout(r, 5));
    await finish(spawned[1].child, [], 7, ["ERROR: /m/models.json: not a model set manifest (exit 7, assets)"]);
    expect(
      blockText(await p2)
        .split("\n")
        .find((l) => l.includes("Models")),
    ).toMatch(/^✗ Models +\/m\/models.json: not a model set manifest$/);
  });
});

describe("Phase 4: history shortcuts", () => {
  it("sudo !! after a refusal runs the line before as sudo; the block shows the expanded line and what was typed", async () => {
    const { c } = make();
    const refused = await c.run("render shot.mov -o ../out/sh010 --overwrite");
    expect(refused.lines[0].text).toMatch(/run it as sudo .* \(or type sudo !!\)$/);
    const b = await c.run("sudo !!");
    expect(b.line).toBe("sudo render shot.mov -o ../out/sh010 --overwrite");
    expect(b.lines[0]).toEqual({ kind: "info", text: "from sudo !!" });
    expect(confirms).toHaveLength(1);
    expect(spawned).toHaveLength(1);
    // the history keeps what ran (bash's rule), never "sudo !!"
    expect(c.history("").map((e) => e.line)).toEqual(["sudo render shot.mov -o ../out/sh010 --overwrite", "render shot.mov -o ../out/sh010 --overwrite"]);
  });

  it("!N, !-N, !prefix, !$ and ^old^new from the stable numbers; a missing one is refused and not kept", async () => {
    const { c } = make();
    await c.run("cd ..");
    await c.run("pwd");
    const n = c.history("")[1].n;
    expect((await c.run(`!${n}`)).line).toBe("cd ..");
    expect((await c.run("!-2")).line).toBe("pwd");
    expect((await c.run("!pw")).line).toBe("pwd");
    expect((await c.run("dir !$")).line).toBe("dir pwd");
    expect((await c.run("^dir pwd^dir")).line).toBe("dir");
    const bad = await c.run("!nothing");
    expect([bad.state, bad.lines[0].text]).toEqual(["refused", "!nothing: no line in the history starts with nothing"]);
    expect(c.history("nothing")).toEqual([]);
    // a file name with ! or a frame token is never expanded
    expect((await c.run("dir sh010!")).line).toBe("dir sh010!");
    expect((await c.run("dir !$F4.exr")).line).toBe("dir !$F4.exr");
  });

  it("a script's lines are never expanded (bash's non-interactive rule)", async () => {
    const { c } = make();
    await c.run("pwd");
    const b = await c.runLines(["!!", "pwd"]);
    await new Promise((r) => setTimeout(r, 20));
    expect(blocks.get(b.id)!.state).toBe("failed");
    expect([...blocks.values()].find((x) => x.parent === b.id)!.lines[0].text).toMatch(/unknown command '!!'/);
  });
});

describe("Phase 4: teach by echo", () => {
  it("a queue job's line is an informational block: done, no exit code, never run, never in the history", async () => {
    const { c } = make();
    c.echo("corridorkey render -i a.mov -o /out/a", "The queue started a.mov; as a command line:");
    const b = [...blocks.values()].at(-1)!;
    expect(b).toMatchObject({ line: "corridorkey render -i a.mov -o /out/a", state: "done", exitCode: null, echo: "The queue started a.mov; as a command line:", argv: null });
    expect(spawned).toEqual([]);
    expect(c.history("")).toEqual([]);
  });
});

describe("Phase 4: farm export", () => {
  const qjob = (name: string, over: Partial<Job> = {}): Job =>
    ({
      id: name,
      clip: {
        path: join(shots, `${name}.mov`),
        name: `${name}.mov`,
        kind: "video",
        width: 64,
        height: 64,
        fps: 24,
        frames: 24,
        thumb: null,
        companionFirstFrame: null,
        companionHintVideo: null,
        probeError: null,
      },
      options: { ...DEFAULT_OPTIONS, outputs: ["alpha"] },
      outputDir: join(out, name),
      status: "waiting",
      ...over,
    }) as Job;

  it("writes the queue's clips as farm jobs into a folder it may write to, and lists them", async () => {
    queued = [qjob("sh010"), qjob("sh020")];
    const { c } = make();
    const b = await c.run(`farm export deadline --queue -o ${join(out, "farm1")}`);
    expect(b.state, b.lines.map((l) => l.text).join("\n")).toBe("done");
    expect(b.lines[0].text).toBe(`Wrote 7 files in ${join(out, "farm1")}:`);
    expect(readFileSync(join(out, "farm1", "sh010_job_info.txt"), "utf8")).toContain("Frames=1001-1024");
    expect(readFileSync(join(out, "farm1", "sh020_plugin_info.txt"), "utf8")).toContain(`OutputPath=${join(out, "sh020")}\n`);
    // one clip by name or path
    const one = await c.run(`farm export flamenco sh020.mov -o ${join(out, "farm2")}`);
    expect(one.state).toBe("done");
    expect(await readdir(join(out, "farm2"))).toEqual(["scripts", "sh020.flamenco.json"]);
  });

  // SME review 2026-10-27 M2 (probe): an unpadded folder grouped as 1-9, 10-99, 100-120 and Deadline keyed 9 of 120
  // frames, ending green; a folder of two sequences is refused (corridorkey would key them as one clip)
  it("SME M2: a frame folder's range is all of its frames; a folder of several sequences is refused", async () => {
    const folder = (name: string, files: string[]) => {
      const d = join(root, "m2", name);
      mkdirSync(d, { recursive: true });
      // loop: NOT-WORTH — a test's frames
      for (const f of files) writeFileSync(join(d, f), "x");
      return qjob(name, { clip: { ...qjob(name).clip, path: d, name, kind: "frames", frames: files.length } });
    };
    queued = [
      folder(
        "unpadded",
        Array.from({ length: 120 }, (_, i) => `frame.${i + 1}.exr`),
      ),
      folder("sim", ["sim.9997.exr", "sim.9998.exr", "sim.9999.exr", "sim.10000.exr", "sim.10001.exr", "sim.10002.exr"]),
    ];
    const { c } = make();
    const b = await c.run(`farm export deadline --queue -o ${join(out, "farm-m2")}`);
    expect(b.state, b.lines.map((l) => l.text).join("\n")).toBe("done");
    expect(readFileSync(join(out, "farm-m2", "unpadded_job_info.txt"), "utf8")).toContain("Frames=1-120\n");
    expect(readFileSync(join(out, "farm-m2", "sim_job_info.txt"), "utf8")).toContain("Frames=9997-10002\n");
    queued = [folder("two", ["a.1001.exr", "a.1002.exr", "b.1001.exr", "b.1002.exr"])];
    const two = await c.run(`farm export openjd --queue -o ${join(out, "farm-m2b")}`);
    expect([two.state, two.lines[0].text]).toEqual([
      "refused",
      `${join(root, "m2", "two")}: it holds several sequences or other frames (a.####.exr 1001-1002, b.####.exr 1001-1002), and corridorkey keys a whole folder as one clip: put each sequence in a folder of its own`,
    ]);
  });

  it("refuses: no -o, a clip not in the queue, an empty queue, a folder outside the write scope", async () => {
    const { c } = make();
    expect((await c.run(`farm export shell --queue -o ${join(out, "f")}`)).lines[0].text).toMatch(/The queue is empty/);
    queued = [qjob("sh010")];
    expect((await c.run("farm export shell --queue")).lines[0].text).toMatch(/needs -o <folder>/);
    expect((await c.run("farm export shell")).state).toBe("refused");
    expect((await c.run(`farm export shell sh099.mov -o ${join(out, "f")}`)).lines[0].text).toMatch(/sh099.mov isn't in the queue/);
    const outside = await c.run(`farm export shell --queue -o ${elsewhere}`);
    expect([outside.state, outside.lines[0].text]).toEqual(["refused", expect.stringMatching(/outside the folders the Console may write to.*allow/)]);
    expect((await c.run("farm export maya --queue -o x")).state).toBe("refused");
  });

  it("never replaces its files without sudo … --overwrite, which asks once and is audited", async () => {
    queued = [qjob("sh010")];
    const { c, files } = make();
    const dir = join(out, "farm3");
    expect((await c.run(`farm export openjd --queue -o ${dir}`)).state).toBe("done");
    const again = await c.run(`farm export openjd --queue -o ${dir}`);
    expect([again.state, again.lines[0].text]).toEqual([
      "refused",
      `2 of its files are already there (${join(dir, "sh010", "template.yaml")}, …): sudo farm export openjd --queue -o ${dir} --overwrite replaces them.`,
    ]);
    expect((await c.run(`farm export openjd --queue -o ${dir} --overwrite`)).lines[0].text).toMatch(/replaces files that are already there: run it as sudo/);
    confirmAnswer = false;
    expect((await c.run(`sudo farm export openjd --queue -o ${dir} --overwrite`)).state).toBe("refused");
    confirmAnswer = true;
    const ok = await c.run(`sudo farm export openjd --queue -o ${dir} --overwrite`);
    expect([ok.state, ok.elevated]).toEqual(["done", true]);
    expect(confirms.at(-1)!.targets.map((t) => t.files)).toEqual([1, 1]);
    const audit = readFileSync(join(files, "console-audit.jsonl"), "utf8");
    expect(audit).toMatch(/"event":"run","argv":\["farm","export","openjd"/);
  });

  // senior review 2026-10-27 M2 (probe P9): links planted in the export folder were followed out of the write scope
  it("never writes through a link in the export folder: a dangling file link, a linked folder, an existing target with sudo", async () => {
    queued = [qjob("sh010")];
    const { c } = make();
    const outside = mkdtempSync(join(elsewhere, "p9-"));
    // a dangling link at a file it writes ("not there", so no sudo was needed)
    const d1 = join(out, "farm-p9a");
    mkdirSync(d1);
    symlinkSync(join(outside, "planted.txt"), join(d1, "sh010_job_info.txt"));
    const a = await c.run(`farm export deadline --queue -o ${d1}`);
    expect([a.state, a.lines[0].text]).toEqual(["refused", expect.stringMatching(/sh010_job_info.txt is a link: farm export never writes through one/)]);
    // a linked folder (CorridorKey/ → outside)
    const d2 = join(out, "farm-p9b");
    mkdirSync(d2);
    symlinkSync(outside, join(d2, "CorridorKey"));
    const b = await c.run(`farm export deadline --queue -o ${d2}`);
    expect([b.state, b.lines[0].text]).toEqual(["refused", expect.stringMatching(/CorridorKey.py.*outside the folders the Console may write to/)]);
    // a link to an existing file outside: refused with sudo … --overwrite too (never replaced through the link)
    const d3 = join(out, "farm-p9c");
    mkdirSync(d3);
    writeFileSync(join(outside, "bashrc"), "mine");
    symlinkSync(join(outside, "bashrc"), join(d3, "sh010_plugin_info.txt"));
    const s = await c.run(`sudo farm export deadline --queue -o ${d3} --overwrite`);
    expect(s.state).toBe("refused");
    expect(confirms).toEqual([]);
    expect(readFileSync(join(outside, "bashrc"), "utf8")).toBe("mine");
    // nothing landed outside
    expect((await readdir(outside)).sort()).toEqual(["bashrc"]);
  });

  it("replaces a file it wrote without following a link raced in after the check (a new file renamed over the name)", async () => {
    const dir = mkdtempSync(join(out, "rf-"));
    const outside = mkdtempSync(join(elsewhere, "rf-"));
    writeFileSync(join(outside, "target"), "mine");
    symlinkSync(join(outside, "target"), join(dir, "job.txt"));
    await replaceFile(join(dir, "job.txt"), "farm");
    expect(readFileSync(join(outside, "target"), "utf8")).toBe("mine");
    expect(readFileSync(join(dir, "job.txt"), "utf8")).toBe("farm");
    expect(lstatSync(join(dir, "job.txt")).isSymbolicLink()).toBe(false);
    expect(await readdir(dir)).toEqual(["job.txt"]);
  });

  it("refuses a queued clip whose name has a new line (M1), writing nothing", async () => {
    queued = [qjob("x\ntouch PWNED\nx")];
    const { c } = make();
    const dir = join(out, "farm-m1");
    const r = await c.run(`farm export opencue --queue -o ${dir}`);
    expect([r.state, r.lines[0].text]).toEqual(["refused", expect.stringMatching(/control character/)]);
    expect(await readdir(dir).catch(() => "none")).toBe("none");
  });
});

describe("Phase 4: sequences everywhere", () => {
  /** plates/sh010_plate.1001-1012.exr without 1005-1006, and a single file */
  function shot() {
    const d = mkdtempSync(join(root, "seq4-"));
    mkdirSync(join(d, "plates"));
    // loop: NOT-WORTH — twelve test frames
    for (let f = 1001; f <= 1012; f++) if (f !== 1005 && f !== 1006) writeFileSync(join(d, "plates", `sh010_plate.${f}.exr`), "x".repeat(10));
    writeFileSync(join(d, "plates", "notes.txt"), "x");
    return d;
  }

  it("dir <pattern> lists that one sequence (any spelling: ####, %04d, $F4, @@@@); -f its frames; none: said", async () => {
    const d = shot();
    const { c } = make({ startDir: d });
    // loop: NOT-WORTH — four spellings
    for (const p of ["plates/sh010_plate.####.exr", "plates/sh010_plate.%04d.exr", "plates/sh010_plate.$F4.exr", "plates/sh010_plate.@@@@.exr"]) {
      const b = await c.run(`dir '${p}'`);
      expect(
        b.entries!.map((e) => [e.name, e.bytes, e.sequence]),
        p,
      ).toEqual([["sh010_plate.####.exr", 100, { range: "1001-1012", count: 10, missing: "1005-1006" }]]);
    }
    const f = await c.run("dir -f plates/sh010_plate.####.exr");
    expect(f.entries!.map((e) => e.name)).toHaveLength(10);
    expect(f.entries![0].name).toBe("sh010_plate.1001.exr");
    const none = await c.run("dir plates/sh020_plate.####.exr");
    expect([none.state, none.lines[0].text]).toEqual(["failed", `No frame of sh020_plate.####.exr in ${join(d, "plates")}. dir ${join(d, "plates")} lists what is there.`]);
  });

  it("open <pattern> shows its first frame; cd and allow take a pattern's folder", async () => {
    const d = shot();
    const { c } = make({ startDir: d });
    expect((await c.run("open plates/sh010_plate.%04d.exr")).state).toBe("done");
    expect(shown).toEqual([join(d, "plates", "sh010_plate.1001.exr")]);
    const cd = await c.run("cd plates/sh010_plate.####.exr");
    expect([cd.state, c.session().cwd]).toEqual(["done", join(d, "plates")]);
    await c.run(`cd ${d}`);
    const a = await c.run("allow plates/key.####.exr");
    expect([a.state, allowAsked]).toEqual(["done", [join(d, "plates")]]);
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
    expect(scriptAsks).toEqual([
      {
        script: "d.ckcmd",
        lines: ["d.ckcmd:2  sudo render shot.mov -o ../out/e/ --overwrite", "d.ckcmd:3  sudo render shot.mov -o ../out/f/ --overwrite"],
        targets: [
          { path: join(out, "e"), files: 0, bytes: 0 },
          { path: join(out, "f"), files: 0, bytes: 0 },
        ],
        movesFolder: false,
      },
    ]);
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

describe("Phase 4: bookmarks, j, pushd and popd", () => {
  it("bookmark names a folder (the current one by default), cd @name goes there, @name/more inside it; -d removes it", async () => {
    const { c } = make();
    expect((await c.run("bookmark sh010 ../out/sh010")).lines[0].text).toBe(`@sh010 is ${join(out, "sh010")}: cd @sh010 goes there.`);
    expect((await c.run("bookmark shots")).state).toBe("done");
    expect(marks).toEqual({ sh010: join(out, "sh010"), shots });
    await c.run("cd @sh010");
    expect(c.session().cwd).toBe(join(out, "sh010"));
    await c.run("cd @shots");
    await c.run("cd @out/..");
    expect(c.session().cwd).toBe(shots);
    const missing = await c.run("cd @nope");
    expect([missing.state, missing.lines[0].text]).toEqual(["failed", "No bookmark nope (bookmarks lists them; bookmark <name> <folder> makes one)."]);
    expect((await c.run("dir @sh010")).entries!.map((e) => e.name)).toEqual(["key.####.exr"]);
    expect((await c.run("bookmarks")).lines.map((l) => l.text)).toEqual([`@sh010  ${join(out, "sh010")}`, `@shots  ${shots}`]);
    expect((await c.run("bookmark -d sh010")).state).toBe("done");
    expect(Object.keys(marks)).toEqual(["shots"]);
    // a name cd @ can't reach, or one that isn't a folder, is refused; a frame token's @@@@ is never a bookmark
    expect((await c.run("bookmark @x")).state).toBe("refused");
    expect((await c.run("bookmark mov shot.mov")).state).toBe("failed");
    expect((await c.run("dir @@@@.exr")).lines[0].text).toMatch(/^No frame of @@@@.exr/);
  });

  it("Tab completes @name to the bookmark, and @name/ inside its folder", async () => {
    const { c } = make();
    marks = { sh010: join(out, "sh010"), shots };
    expect((await c.complete("cd @s", 5)).items.map((i) => i.insert)).toEqual(["@sh010/", "@shots/"]);
    expect((await c.complete("dir @sh010/k", 12)).items.map((i) => i.insert)).toEqual(["@sh010/key.####.exr"]);
  });

  it("j goes to the best-ranked history folder matching the parts (the last one in its name), skipping gone ones", async () => {
    const { c } = make();
    await c.run("cd ../out/sh010");
    await c.run("pwd");
    await c.run("pwd");
    await c.run("cd ../../elsewhere");
    await c.run("pwd");
    await c.run("cd /");
    const b = await c.run("j sh0");
    expect([b.state, b.lines[0].text]).toEqual(["done", join(out, "sh010")]);
    // the page shows it shortened (whole on hover and in Copy output)
    expect(b.paths).toEqual([join(out, "sh010")]);
    expect(c.session().cwd).toBe(join(out, "sh010"));
    expect((await c.run("j out")).state).toBe("failed");
    expect((await c.run("j else")).lines[0].text).toBe(elsewhere);
    const list = (await c.run("j")).lines.map((l) => l.text.trim());
    expect(list[0]).toMatch(/^\d+\.\d\d  /);
    expect(list[0].endsWith(join(out, "sh010"))).toBe(true);
  });

  it("pushd remembers the folder, popd comes back, dirs lists them (0 is where you are); pushd alone swaps", async () => {
    const { c } = make();
    const p = await c.run("pushd ../out");
    expect(p.lines.map((l) => l.text)).toEqual([` 0  ${out}`, ` 1  ${shots}`]);
    await c.run("pushd sh010");
    expect((await c.run("dirs")).lines.map((l) => l.text)).toEqual([` 0  ${join(out, "sh010")}`, ` 1  ${out}`, ` 2  ${shots}`]);
    await c.run("pushd");
    expect(c.session().cwd).toBe(out);
    await c.run("popd");
    expect(c.session().cwd).toBe(join(out, "sh010"));
    await c.run("popd");
    expect(c.session().cwd).toBe(shots);
    const none = await c.run("popd");
    expect([none.state, none.lines[0].text]).toEqual(["failed", "Nothing to go back to: pushd <folder> remembers where you are first."]);
    expect((await c.run("pushd nowhere")).state).toBe("failed");
    expect((await c.run("dirs")).lines).toHaveLength(1);
  });
});

describe("Phase 4: variables", () => {
  it("set name=value for this session; ${name} fills it in; the block shows what ran and what was typed; the history keeps ${name}", async () => {
    const { c } = make();
    expect((await c.run("set shot=sh010 dest=../out")).state).toBe("done");
    const b = await c.run("dir ${dest}/${shot}");
    expect(b.line).toBe('dir "../out/sh010"');
    expect(b.lines[0]).toEqual({ kind: "info", text: "from dir ${dest}/${shot}" });
    expect(b.entries!.map((e) => e.name)).toEqual(["key.####.exr"]);
    expect(c.history("dir")[0].line).toBe("dir ${dest}/${shot}");
    expect((await c.run("set shot")).lines[0].text).toBe("shot=sh010");
    expect((await c.run("set")).lines.map((l) => l.text).slice(0, 2)).toEqual(["dest=../out", "shot=sh010"]);
    expect(keptVars).toEqual({});
  });

  it("frame tokens and other shells' variables stay as typed: $F, $F4, $HIP, %04d, ####, @@@@, !", async () => {
    const { c } = make();
    for (const l of ["dir plate.$F4.exr", "dir $HIP/plate.%04d.exr", "dir plate.####.exr", "dir @@@@.exr", "dir sh010!.mov", "dir 'take ${shot}'"]) {
      const b = await c.run(l);
      expect(b.line).toBe(l);
      expect(b.lines[0].text).not.toMatch(/variable/);
    }
  });

  it("a value is one quoted word: never split, never a flag, sudo or a command (the destructive flags are the ones typed)", async () => {
    const { c } = make();
    await c.run("set o=--overwrite cmd=render s=sudo");
    const b = await c.run("render shot.mov -o ../out/a ${o}");
    expect(b.state).toBe("refused");
    expect(b.lines.at(-1)!.text).toMatch(/takes no more arguments here: '--overwrite'/);
    expect((await c.run("${cmd} shot.mov -o ../out/a")).lines.at(-1)!.text).toMatch(/unknown command 'render'/);
    expect((await c.run("${s} render shot.mov -o ../out/a --overwrite")).lines.at(-1)!.text).toMatch(/unknown command 'sudo'/);
    expect(spawned).toHaveLength(0);
    expect(confirms).toHaveLength(0);
    await c.run('set two="my shots"');
    expect((await c.run("cd ../${two}")).state).toBe("done");
    expect(c.session().cwd).toBe(shots);
  });

  it("the Console's own are read-only: cwd, home, date, time, status (the last line's exit status)", async () => {
    const { c } = make();
    t = new Date(2026, 9, 27, 9, 5, 7).getTime();
    expect((await c.run("echo ${date} ${time} ${cwd}")).lines.at(-1)!.text).toBe(`2026-10-27 09-05-07 ${shots}`);
    await c.run("cd nowhere");
    expect((await c.run("echo ${status}")).lines.at(-1)!.text).toBe("1");
    expect((await c.run("echo ${status}")).lines.at(-1)!.text).toBe("0");
    expect((await c.run("set cwd=/x")).state).toBe("refused");
    expect((await c.run("unset home")).state).toBe("refused");
    const bad = await c.run("echo ${nope}");
    expect([bad.state, bad.lines[0].text]).toEqual(["refused", "${nope}: no such variable (set lists them; set nope=value makes it)"]);
    expect((await c.run("echo ${a b}")).state).toBe("refused");
    expect((await c.run("set __proto__=x")).state).toBe("refused");
  });

  it("set -p keeps it after a restart (settings); a kept one stays kept; unset removes it from both", async () => {
    const { c } = make();
    await c.run("set -p show=/mnt/show");
    await c.run("set tmp=1");
    expect(keptVars).toEqual({ show: "/mnt/show" });
    await c.run("set show=/mnt/show2");
    expect(keptVars).toEqual({ show: "/mnt/show2" });
    expect((await c.run("set")).lines.map((l) => l.text).slice(0, 2)).toEqual(["show=/mnt/show2  (kept)", "tmp=1"]);
    const again = make().c;
    expect((await again.run("echo ${show}")).lines.at(-1)!.text).toBe("/mnt/show2");
    expect((await again.run("echo ${tmp}")).state).toBe("refused");
    await again.run("unset show");
    expect(keptVars).toEqual({});
  });

  it("a script's lines fill in variables too (each when it runs)", async () => {
    const { c } = make();
    await c.run("set d=../out");
    const b = await c.runLines(["set s=sh010", "dir ${d}/${s}"]);
    await new Promise((r) => setTimeout(r, 20));
    expect(blocks.get(b.id)!.state).toBe("done");
    expect([...blocks.values()].find((x) => x.parent === b.id && x.line.startsWith("dir"))!.line).toBe('dir "../out/sh010"');
  });
});

describe("Phase 4: scripting", () => {
  const kids = (id: number) => [...blocks.values()].filter((x) => x.parent === id);
  const settle = () => new Promise((r) => setTimeout(r, 20));

  it("; && || on a typed line: each command its own block, run as the operator says; the line ends as its last", async () => {
    const { c } = make();
    const b = await c.run("cd nowhere && pwd || echo fallback; version");
    await settle();
    expect(kids(b.id).map((x) => [x.line, x.state])).toEqual([
      ["cd nowhere", "failed"],
      ["echo fallback", "done"],
      ["version", "done"],
    ]);
    expect(blocks.get(b.id)!.state).toBe("done");
    // a typed line goes on after a failure (bash), and ends as its last command did
    const f = await c.run("pwd; cd nowhere");
    await settle();
    expect([kids(f.id).length, blocks.get(f.id)!.state, blocks.get(f.id)!.exitCode]).toEqual([2, "failed", 1]);
    expect(c.history("")[0].line).toBe("pwd; cd nowhere");
    // a pipe is refused, nothing runs
    const p = await c.run("dir | wc");
    expect([p.state, p.lines.at(-1)!.text]).toEqual(["refused", expect.stringMatching(/^\| \(a pipe\) isn't part of the Console/)]);
  });

  it("for over words, a frame sequence's frames and a pattern's files (by name); a pattern matching nothing runs nothing", async () => {
    const { c } = make();
    const echoes = async (line: string) => {
      const b = await c.run(line);
      await settle();
      return kids(b.id).map((x) => x.lines.at(-1)?.text);
    };
    expect(await echoes("for s in sh010 sh020; do echo ${s}; done")).toEqual(["sh010", "sh020"]);
    expect(await echoes("for f in ../out/sh010/key.####.exr; do echo ${f}; done")).toEqual(["../out/sh010/key.1001.exr", "../out/sh010/key.1002.exr"]);
    expect(await echoes("for f in *.exr; do echo ${f}; done")).toEqual(["plate 9.exr", "plate 10.exr"]);
    expect(await echoes("for f in '*.exr'; do echo ${f}; done")).toEqual(["*.exr"]);
    const none = await c.run("for f in *.nope; do echo ${f}; done");
    await settle();
    expect([kids(none.id).length, blocks.get(none.id)!.lines.at(-1)!.text]).toEqual([0, "for f: no file matches *.nope"]);
    // the loop's variable is gone after it; one set before comes back
    await c.run("set s=before");
    await echoes("for s in x; do echo ${s}; done");
    expect((await c.run("echo ${s}")).lines.at(-1)!.text).toBe("before");
  });

  // SME review 2026-10-27 M3 (probe): `for f in ${od}/sh010/key.####.exr` echoed the pattern itself, once, and ended done:
  // the whole word was quoted, so the typed pattern never counted
  it("SME M3: a variable keeps the typed glob and frame pattern around it; its own value is never a pattern", async () => {
    const { c } = make();
    const echoes = async (line: string) => {
      const b = await c.run(line);
      await settle();
      return kids(b.id).map((x) => x.lines.at(-1)?.text ?? blocks.get(b.id)!.lines.at(-1)?.text);
    };
    await c.run(`set od=${out}`);
    expect(await echoes("for f in ${od}/sh010/*.exr; do echo ${f}; done")).toEqual([join(out, "sh010", "key.1001.exr"), join(out, "sh010", "key.1002.exr")]);
    expect(await echoes("for f in ${od}/sh010/key.####.exr; do echo ${f}; done")).toEqual([join(out, "sh010", "key.1001.exr"), join(out, "sh010", "key.1002.exr")]);
    // inside a loop, the outer loop's variable fills in a pattern's folder too
    expect(await echoes("for d in sh010; do for f in ../out/${d}/*.exr; do echo ${f}; done; done")).toEqual(["../out/sh010/key.1001.exr", "../out/sh010/key.1002.exr"]);
    // a value with * (or ####) stays literal: no file has that name, so it is one item, itself
    await c.run("set star=*.exr hashes=key.####.exr");
    expect(await echoes("for f in ${star}; do echo ${f}; done")).toEqual(["*.exr"]);
    expect(await echoes("for f in ../out/sh010/${hashes}; do echo ${f}; done")).toEqual(["../out/sh010/key.####.exr"]);
    // and a value's * is literal inside a typed pattern: only names with a real * match
    const lit = await c.run("for f in ../out/sh010/${star}*; do echo ${f}; done");
    await settle();
    expect(blocks.get(lit.id)!.lines.at(-1)!.text).toBe("for f: no file matches ../out/sh010/*.exr*");
  });

  // SME review 2026-10-27 S10 (probe): set shots="sh010 sh020"; for s in ${shots} ran once with "sh010 sh020"
  it("SME S10: ${name[@]} splits a value into a loop's items; ${name} stays one item and says how to split it", async () => {
    const { c } = make();
    await c.run('set shots="sh010 sh020  sh030"');
    const b = await c.run("for s in ${shots[@]}; do echo ${s}; done");
    await settle();
    expect(kids(b.id).map((x) => x.lines.at(-1)?.text)).toEqual(["sh010", "sh020", "sh030"]);
    // each item is one word, never a flag or a pattern: a value of "--overwrite *.exr" is two plain items
    await c.run('set odd="--overwrite *.exr"');
    const o = await c.run("for s in ${odd[@]}; do echo ${s}; done");
    await settle();
    expect(kids(o.id).map((x) => x.lines.at(-1)?.text)).toEqual(["--overwrite", "*.exr"]);
    const one = await c.run("for s in ${shots}; do echo ${s}; done");
    await settle();
    expect(kids(one.id).map((x) => x.lines.at(-1)?.text)).toEqual(["sh010 sh020  sh030"]);
    expect(blocks.get(one.id)!.lines.map((l) => l.text)).toContain("${shots} is one item (a variable never splits): for s in ${shots[@]} takes its words one by one");
    // [@] is only a for loop's whole word
    expect((await c.run("echo ${shots[@]}")).lines.at(-1)!.text).toBe("${shots[@]}: a list splits only as a whole word of a for loop (for s in ${shots[@]})");
  });

  it("if on the last exit status; else; nested in for", async () => {
    const { c } = make();
    const b = await c.run("if cd nowhere; then echo yes; else echo no; fi");
    await settle();
    expect(kids(b.id).map((x) => x.line)).toEqual(["cd nowhere", "echo no"]);
    expect(blocks.get(b.id)!.state).toBe("done");
    const n = await c.run("for d in .. nowhere; do if cd ${d}; then pwd; fi; done");
    await settle();
    expect(kids(n.id).map((x) => x.line)).toEqual(['cd ".."', "pwd", 'cd "nowhere"']);
  });

  it("a script stops at a failure at the end of its chain (set -e), not on the left of && or in an if; --keep-going goes on", async () => {
    const { c } = make();
    writeFileSync(join(shots, "k.ckcmd"), "cd nowhere && pwd\nif cd nowhere; then pwd; fi\nfor s in a b\ndo\n  echo ${s}\ndone\ncd nowhere\necho never\n");
    const b = await c.run("run k.ckcmd");
    await settle();
    expect(kids(b.id).map((x) => x.line)).toEqual(["cd nowhere", "cd nowhere", 'echo "a"', 'echo "b"', "cd nowhere"]);
    expect(blocks.get(b.id)!.lines.at(-1)!.text).toBe("stopped at line 7: failed");
    const k = await c.run("run --keep-going k.ckcmd");
    await settle();
    expect(kids(k.id).at(-1)!.line).toBe("echo never");
    expect([blocks.get(k.id)!.state, blocks.get(k.id)!.lines.at(-1)!.text]).toEqual(["failed", "1 command failed (--keep-going went on)"]);
    writeFileSync(join(shots, "bad.ckcmd"), "pwd\nfor x in a; do pwd\n");
    const bad = await c.run("run bad.ckcmd");
    expect([bad.state, bad.lines.at(-1)!.text]).toEqual(["refused", "bad.ckcmd:2: for x: done is missing (for … ; do … ; done); nothing ran."]);
  });

  it("elevation as for scripts: a typed line's commands that replace files say sudo, all in one confirmation up front", async () => {
    const { c } = make();
    const bare = await c.run("pwd && render shot.mov -o ../out/e/ --overwrite");
    expect([bare.state, bare.lines[0].text]).toEqual(["refused", "replaces files: a line with ; && || for or if says so with sudo (sudo render shot.mov -o ../out/e/ --overwrite); nothing ran."]);
    const b = await c.run("for s in e f; do sudo render shot.mov -o ../out/${s}/ --overwrite; done");
    expect(scriptAsks).toEqual([
      {
        script: "the line typed",
        lines: ["sudo render shot.mov -o ../out/${s}/ --overwrite   (its ${…} are filled in when it runs: the program's loop or set gives them)"],
        targets: [],
        movesFolder: false,
      },
    ]);
    await settle();
    expect(spawned).toHaveLength(1);
    expect(spawned[0].args).toContain(join(out, "e"));
    await finish(spawned[0].child, [], 0);
    await settle();
    expect(spawned).toHaveLength(2);
    await finish(spawned[1].child, [], 0);
    await settle();
    expect(blocks.get(b.id)!.state).toBe("done");
    // the session was never elevated
    expect(c.session().elevatedUntil).toBeNull();
  });

  it("time: how long a command took; a render's frames per second from its own events", async () => {
    const { c } = make();
    const b = await c.run("time render shot.mov -o ../out/t");
    await settle();
    (spawned[0].child.stdout as PassThrough).write('{"event":"progress","percent":100,"done":50,"total":50}\n');
    t += 2000;
    await finish(spawned[0].child, [], 0);
    await settle();
    expect(blocks.get(b.id)!.lines.at(-1)!.text).toBe("time: 2.0 s · 50 frames · 25.00 fps (render shot.mov -o ../out/t)");
    expect((await c.run("sudo time pwd")).lines.at(-1)!.text).toMatch(/time goes first/);
  });

  it("Tab completes the command the cursor is in, and a for's words as files", async () => {
    const { c } = make();
    expect((await c.complete("pwd && ren", 10)).items.map((i) => i.insert)).toEqual(["render"]);
    const r = await c.complete("for f in sh", 11);
    expect([r.start, r.items.map((i) => i.insert)]).toEqual([9, ["shot.mov"]]);
  });
});

describe("Phase 4: file built-ins (read-only)", () => {
  const dir = join(root, "texts");
  mkdirSync(join(dir, "sub", "deep"), { recursive: true });
  writeFileSync(join(dir, "notes.txt"), "one two\nthree\n\nfour five six\n");
  writeFileSync(join(dir, "bin.dat"), Buffer.from([1, 0, 2, 3]));
  writeFileSync(join(dir, "sub", "a.1001.exr"), "1234");
  writeFileSync(join(dir, "sub", "a.1002.exr"), "1234");
  writeFileSync(join(dir, "sub", "deep", "x.txt"), "x".repeat(2048));
  const text = (b: ConsoleBlock) => b.lines.map((l) => l.text);

  it("cat (type) prints a text file, refuses a binary one and a folder; head and tail -n", async () => {
    const { c } = make({ startDir: dir });
    expect(text(await c.run("cat notes.txt"))).toEqual(["one two", "three", "", "four five six"]);
    expect(text(await c.run("type notes.txt"))).toEqual(["one two", "three", "", "four five six"]);
    expect((await c.run("cat bin.dat")).lines[0].text).toMatch(/^bin.dat isn't text/);
    expect((await c.run("cat sub")).lines[0].text).toBe("sub isn't a file (it is a folder: dir lists it).");
    expect(text(await c.run("head -n 2 notes.txt"))).toEqual(["one two", "three"]);
    expect(text(await c.run("tail -n 2 notes.txt"))).toEqual(["", "four five six"]);
    expect(text(await c.run("tail notes.txt"))).toHaveLength(4);
  });

  it("wc counts lines, words and bytes; several files with a total", async () => {
    const { c } = make({ startDir: dir });
    expect(text(await c.run("wc notes.txt sub/deep/x.txt"))).toEqual(["lines  words  bytes", "    4      6     29  notes.txt", "    0      1   2048  sub/deep/x.txt", "    4      7   2077  total"]);
  });

  it("du sizes each folder inside and the total; tree draws folders with sequences as one row, to a depth", async () => {
    const { c } = make({ startDir: dir });
    expect(text(await c.run("du"))).toEqual(["     2.0 KiB  sub/", "     2.0 KiB  . (total)"]);
    expect(text(await c.run("tree"))).toEqual([".", "├── bin.dat", "├── notes.txt", "└── sub/", "    ├── a.####.exr  1001-1002 · 2 frames", "    └── deep/", "2 folders, 3 files or sequences"]);
    // a drawing: the page never wraps its lines
    expect((await c.run("tree")).nowrap).toBe(true);
    expect(text(await c.run("tree -L 3 sub"))).toEqual(["sub", "├── a.####.exr  1001-1002 · 2 frames", "└── deep/", "    └── x.txt", "1 folder, 2 files or sequences"]);
  });
});

// senior review 2026-10-27 M4 (probes P3, P4, P5): a throw inside a program kept the job slot until restart, a thrown
// single line made no block, a loop of built-ins never yielded (Ctrl+C couldn't arrive) and nested loops multiplied the
// item cap
describe("review 2026-10-27 M4: a program's throws, budget and Ctrl+C", () => {
  const kids = (id: number) => [...blocks.values()].filter((x) => x.parent === id);
  /** the program's block once it has ended (it runs on after run() resolves) */
  async function ended(b: ConsoleBlock): Promise<ConsoleBlock> {
    // loop: NOT-WORTH — a test's wait [bounded: 30 s]
    for (let i = 0; i < 3000 && b.state === "running"; i++) await new Promise((r) => setTimeout(r, 10));
    return b;
  }
  const eacces = (p: string) => Object.assign(new Error(`EACCES: permission denied, open '${p}'`), { code: "EACCES", path: p });
  /** a disk where the file's stat works but opening it doesn't (P3: mode 0000) */
  const unreadable = () => {
    const base = make().deps.fs;
    return make({
      startDir: sdir,
      fs: {
        ...base,
        readRange: async (p) => {
          throw eacces(p);
        },
      },
    }).c;
  };
  const sdir = mkdtempSync(join(root, "m4s-"));
  writeFileSync(join(sdir, "secret.txt"), "x");
  writeFileSync(join(sdir, "shot.mov"), "x");

  it("P3: an unreadable file inside a program fails that command, the program goes on, and the slot is free after", async () => {
    const c = unreadable();
    const b = await ended(await c.run("cat secret.txt; echo after"));
    expect(kids(b.id).map((x) => [x.line, x.state])).toEqual([
      ["cat secret.txt", "failed"],
      ["echo after", "done"],
    ]);
    expect(kids(b.id)[0].lines.at(-1)!.text).toBe(`cat: you have no permission to open ${join(sdir, "secret.txt")}.`);
    const next = await ended(await c.run("echo a; echo b"));
    expect(next.state).toBe("done");
    expect((await c.run("render shot.mov -o ../out/a")).state).toBe("running");
    await finish(spawned[0].child, [], 0);
  });

  it("P3: the same throw on a single line is a failed block (never a rejected call with no block)", async () => {
    const b = await unreadable().run("cat secret.txt");
    expect([b.state, b.lines.at(-1)!.text]).toEqual(["failed", `cat: you have no permission to open ${join(sdir, "secret.txt")}.`]);
  });

  it("P4: for over more than 130 000 matches is refused at the item cap (no RangeError), and the slot is free after", async () => {
    const many = Array.from({ length: 140_001 }, (_, i) => ({ name: `f${i}.exr`, isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false }) as unknown as Dirent);
    const base = make().deps.fs;
    const { c } = make({ fs: { ...base, readdir: async (p) => (p.endsWith("big") ? many : base.readdir(p)) } });
    const b = await ended(await c.run("for f in big/*.exr; do echo ${f}; done; echo after"));
    expect(b.lines.map((l) => l.text)).toContain("for f: more than 10000 items: name a smaller set");
    expect((await ended(await c.run("echo a; echo b"))).state).toBe("done");
  });

  it("P5: nested loops share one budget for the whole program (10 000 commands), then it stops, failed", async () => {
    const d = mkdtempSync(join(root, "m4-"));
    // loop: NOT-WORTH — 120 test files
    for (let i = 0; i < 120; i++) writeFileSync(join(d, `f${i}`), "");
    const { c } = make({ startDir: d });
    const b = await ended(await c.run("for a in *; do for b in *; do echo x; done; done"));
    expect(b.state).toBe("failed");
    expect(kids(b.id)).toHaveLength(10_000);
    expect(b.lines.at(-1)!.text).toMatch(/^stopped: more than 10000 commands in one program/);
  }, 60_000);

  it("P5: Ctrl+C reaches a loop of built-ins within 100 ms (it yields between commands) and stops it", async () => {
    // words, not patterns: no file is read, so nothing but the runner itself could let the timer in
    // loop: NOT-WORTH — a test's words
    const w = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
    const { c } = make();
    const start = performance.now();
    let fired = 0;
    setTimeout(() => {
      fired = performance.now() - start;
      c.cancel();
    }, 5);
    const b = await ended(await c.run(`for a in ${w(300)}; do for b in ${w(100)}; do echo \${a} \${b}; done; done`));
    expect(fired).toBeGreaterThan(0);
    expect(fired).toBeLessThan(100);
    expect(b.state).toBe("cancelled");
    expect(kids(b.id).length).toBeLessThan(10_000);
  }, 60_000);
});

// senior review 2026-10-27 S6: du (200 000 stats), tree, wc (256 MiB) and j (a stat per remembered folder) held no slot
// and Ctrl+C couldn't stop them
describe("review 2026-10-27 S6: the long built-ins take the slot and stop on Ctrl+C", () => {
  it("du, tree, wc and j: another command is busy while they run; Ctrl+C ends them cancelled", async () => {
    const d = mkdtempSync(join(root, "s6-"));
    mkdirSync(join(d, "a"));
    writeFileSync(join(d, "a", "x"), "x");
    writeFileSync(join(d, "big.txt"), "x ".repeat(1536 * 1024));
    let open!: () => void;
    let gate = Promise.resolve();
    const base = make().deps.fs;
    /** a slow disk under d: each read waits for the gate */
    const slow = async <T>(p: string, f: () => Promise<T>) => {
      if (p.startsWith(d)) await gate;
      return f();
    };
    const { c } = make({
      startDir: d,
      fs: { ...base, readdir: (p) => slow(p, () => base.readdir(p)), stat: (p) => slow(p, () => base.stat(p)), readRange: (p, s, l) => slow(p, () => base.readRange(p, s, l)) },
    });
    // j needs d in the history, typed from elsewhere
    await c.run("pwd");
    await c.run(`cd ${root}`);
    // loop: NOT-WORTH — four commands
    for (const line of [`du ${d}`, `tree ${d}`, `wc ${join(d, "big.txt")}`, "j s6"]) {
      gate = new Promise<void>((r) => (open = r));
      const running = c.run(line);
      await new Promise((r) => setTimeout(r, 10));
      const other = await c.run("pwd; pwd");
      expect([line, other.state, other.lines.at(-1)!.text]).toEqual([line, "refused", expect.stringMatching(new RegExp(`^Busy with ${line.split(" ")[0]}`))]);
      c.cancel();
      open();
      const b = await running;
      expect([line, b.state]).toEqual([line, "cancelled"]);
      // the slot is free again
      expect((await c.run("version")).state).toBe("done");
    }
  });
});

// senior review 2026-10-27 S2 (probe P6): a program's one confirmation showed `-o ${o}` unfilled and no targets
describe("review 2026-10-27 S2: a program's confirmation shows its lines filled in and what they replace", () => {
  it("a session variable: the line as it will run and the files there now, counted as the single command's dialog counts them", async () => {
    const d = join(out, "s2");
    mkdirSync(join(d, "shot_alpha_exr"), { recursive: true });
    writeFileSync(join(d, "shot_alpha_exr", "shot_alpha.1001.exr"), "123");
    writeFileSync(join(d, "shot_alpha_exr", "shot_alpha.1002.exr"), "123");
    writeFileSync(join(d, "other.txt"), "123456");
    const { c } = make();
    await c.run("set o=../out/s2/");
    confirmAnswer = false;
    await c.run("pwd; sudo render shot.mov -o ${o} --overwrite");
    expect(scriptAsks).toEqual([
      {
        script: "the line typed",
        lines: ['sudo render shot.mov -o ${o} --overwrite   →  sudo render shot.mov -o "../out/s2/" --overwrite'],
        targets: [{ path: d, files: 2, bytes: 6 }],
        movesFolder: false,
      },
    ]);
  });

  it("P6: a variable the program sets (or a loop's) is said to be filled in when it runs; a cd makes relative folders uncounted", async () => {
    const { c } = make();
    confirmAnswer = false;
    await c.run("set o=../out/s3/; sudo render shot.mov -o ${o} --overwrite");
    expect(scriptAsks[0].lines).toEqual(["sudo render shot.mov -o ${o} --overwrite   (its ${…} are filled in when it runs: the program's loop or set gives them)"]);
    expect(scriptAsks[0].targets).toEqual([]);
    await c.run("cd ..; sudo render shot.mov -o out/s4/ --overwrite");
    expect(scriptAsks[1]).toMatchObject({ targets: [], movesFolder: true });
  });

  it("a confirmed line runs only as it was shown filled in", async () => {
    const { c } = make();
    await c.run("set o=../out/s5/");
    const b = await c.run("pwd; sudo render shot.mov -o ${o} --overwrite");
    await new Promise((r) => setTimeout(r, 20));
    expect(spawned).toHaveLength(1);
    expect(spawned[0].args).toContain(join(out, "s5"));
    await finish(spawned[0].child, [], 0);
    expect(b.state).not.toBe("refused");
  });
});

// senior review 2026-10-27 S1: Electron's powerMonitor has no lock-screen event on Linux (darwin, win32 only), so a locked
// screen kept the elevation there. While elevated, logind's LockedHint is read; where it can't be, the window's blur drops.
describe("review 2026-10-27 S1: the elevation drops on a Linux screen lock", () => {
  const watch = (answers: (boolean | null)[], active = { v: true }) => {
    const dropped: string[] = [];
    let asked = 0;
    const w = new LinuxLockWatch(
      async () => answers[Math.min(asked++, answers.length - 1)],
      () => active.v,
      (why) => {
        dropped.push(why);
        active.v = false;
        w.update();
      },
    );
    return { w, dropped, asked: () => asked, active };
  };

  it("reads busctl's answer for LockedHint", () => {
    expect([parseLockedHint("b true\n"), parseLockedHint("b false"), parseLockedHint(""), parseLockedHint("Failed to get property")]).toEqual([true, false, null, null]);
  });

  it("while elevated it polls the lock and drops when the screen is locked; not elevated, it reads nothing", async () => {
    vi.useFakeTimers();
    try {
      const idle = watch([false], { v: false });
      idle.w.update();
      await vi.advanceTimersByTimeAsync(LOCK_POLL_MS * 3);
      expect(idle.asked()).toBe(0);
      const t = watch([false, true]);
      t.w.update();
      await vi.advanceTimersByTimeAsync(LOCK_POLL_MS);
      expect(t.dropped).toEqual([]);
      await vi.advanceTimersByTimeAsync(LOCK_POLL_MS);
      expect(t.dropped).toEqual(["the screen was locked"]);
      // dropped: it stops reading
      await vi.advanceTimersByTimeAsync(LOCK_POLL_MS * 3);
      expect(t.asked()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("where the lock can't be read (no logind, no busctl) the window's blur drops it instead; where it can, blur never does", async () => {
    const none = watch([null]);
    await none.w.probe();
    none.w.blur();
    expect(none.dropped).toEqual(["the window lost focus (this system's screen lock can't be read)"]);
    const ok = watch([false]);
    await ok.w.probe();
    ok.w.blur();
    expect(ok.dropped).toEqual([]);
    // a read that starts failing later: from then on blur drops
    vi.useFakeTimers();
    try {
      const later = watch([false, null]);
      await later.w.probe();
      later.w.update();
      await vi.advanceTimersByTimeAsync(LOCK_POLL_MS);
      later.w.blur();
      expect(later.dropped).toEqual(["the window lost focus (this system's screen lock can't be read)"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
