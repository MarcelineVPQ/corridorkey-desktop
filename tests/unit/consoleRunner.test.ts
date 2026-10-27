// The Console's runner with a fake spawn (as engine.test.ts): the exact argv, never a shell, cancel semantics, the CLI's
// JSON events into blocks, the file scope and the sudo flow end to end. Real files only in a temp folder of its own.
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Console, type ConsoleDeps, type ElevationRequest } from "../../electron/main/console/runner";
import { Elevation } from "../../electron/main/console/elevation";
import { AuditLog, History } from "../../electron/main/console/logs";
import { BlockPusher, PUSH_EVERY_MS } from "../../electron/main/console/push";
import { consoleLineArg, cursorArg, fromAppPage } from "../../electron/main/validate";
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
let gpuTaken: number;
let gpuReleased: number;
let gpuRefusal: string | null;
let killed: number[];
let t: number;
let blocks: Map<number, ConsoleBlock>;
let cli: string | null;
let runtimeOk: boolean;

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
    writeRoots: () => [out],
    takeGpu: () => {
      if (gpuRefusal) return gpuRefusal;
      gpuTaken++;
      return null;
    },
    releaseGpu: () => void gpuReleased++,
    confirm: async (r) => (confirms.push(r), confirmAnswer),
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
    ...over,
  };
  return { c: new Console(deps), deps, files };
}

beforeEach(() => {
  spawned = [];
  confirms = [];
  confirmAnswer = true;
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
    expect(confirms[0].command).toBe(`sudo corridorkey render --temp ${join(out, ".console-temp")} --progress-format json --output ${join(out, "sh010")} --overwrite -- shot.mov`);
    expect(confirms[0].targets).toEqual([{ path: join(out, "sh010"), files: 2, bytes: 10 }]);
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

  it("is dropped by sudo -k and by the window's blur (audited), and asks again after", async () => {
    const { c, files } = make();
    await c.run("sudo render shot.mov -o ../out/sh010 --overwrite");
    await finish(spawned[0].child, [], 0);
    expect((await c.run("sudo -k")).lines[0].text).toBe("Not elevated.");
    expect(c.session().elevatedUntil).toBeNull();
    await c.run("sudo render shot.mov -o ../out/sh010 --overwrite");
    expect(confirms).toHaveLength(2);
    await finish(spawned[1].child, [], 0);
    c.dropElevation("the window lost focus");
    await new Promise((r) => setTimeout(r, 5));
    const events = readFileSync(join(files, "console-audit.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    // loop: NOT-WORTH — a few entries
    expect(events.filter((e) => e.event === "dropped").map((e) => e.reason)).toEqual(["sudo -k", "the window lost focus"]);
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
    expect((await c.run("cd ..")).lines[0].text).toBe(root);
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
    expect(b.lines[0].text).toMatch(/3 files \(3 bytes\), 0 folders/);
    expect((await c.run("dir ..")).entries!.some((e) => e.name === "out" && e.folder)).toBe(true);
  });

  it("help, <command> ?, find", async () => {
    const { c } = make();
    expect((await c.run("help")).lines.map((l) => l.text).join("\n")).toMatch(/render .*uses the graphics card/);
    const h = (await c.run("render ?")).lines.map((l) => l.text);
    expect(h[0]).toBe("usage: corridorkey render [OPTIONS] [INPUT]");
    expect(h.join("\n")).toMatch(/--overwrite .*\(needs sudo\)/);
    expect(h.join("\n")).toMatch(/-o, --output DIR\|PATTERN .*\(only into chosen folders\)/);
    expect(h).not.toContain(expect.stringMatching(/progress-format/));
    expect((await c.run("help ls")).lines[0].text).toBe("usage: dir [FOLDER]");
    expect((await c.run("find overwrite")).lines.map((l) => l.text).join("\n")).toMatch(/corridorkey render --overwrite/);
    expect((await c.run("find zzzz")).lines[0].text).toMatch(/Nothing matches/);
  });

  it("cls clears; history lists what was typed; history --audit the elevated log", async () => {
    const { c } = make();
    expect((await c.run("cls")).clear).toBe(true);
    await c.run("pwd");
    await new Promise((r) => setTimeout(r, 5));
    expect((await c.run("history")).lines.map((l) => l.text)).toEqual(["   1  cls", "   2  pwd"]);
    expect((await c.run("history --audit")).lines[0].text).toBe("Nothing elevated yet.");
    expect(c.history("PW")).toEqual(["pwd"]);
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
});
