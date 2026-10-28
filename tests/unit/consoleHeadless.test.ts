// `corridorkey run FILE.ckcmd` (SME review 2026-10-27 N12, backlog row 151): the script runner the CLI starts in the
// app as Node (electron/main/console/headless.ts): where the app's settings are, its arguments, and what it prints.
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { headlessArgs, onStopLines, Printer, refusal, STOP_LINE, userDataDir } from "../../electron/main/console/headless";
import type { ConsoleBlock } from "../../src/shared/types";

const block = (extra: Partial<ConsoleBlock>): ConsoleBlock => ({
  id: 1,
  line: "run nightly.ckcmd",
  parent: null,
  cwd: "/",
  argv: null,
  elevated: false,
  state: "running",
  exitCode: null,
  exitMeaning: null,
  startedAt: 0,
  finishedAt: null,
  progress: null,
  status: null,
  lines: [],
  linesDropped: 0,
  entries: null,
  errors: [],
  clear: false,
  ...extra,
});

describe("corridorkey run's script runner", () => {
  it("finds the app's settings where Electron keeps its userData, per system", () => {
    expect(userDataDir("corridorkey-desktop", {}, "/home/m", "linux")).toBe("/home/m/.config/corridorkey-desktop");
    expect(userDataDir("corridorkey-desktop", { XDG_CONFIG_HOME: "/x" }, "/home/m", "linux")).toBe("/x/corridorkey-desktop");
    expect(userDataDir("CorridorKey", {}, "/Users/m", "darwin")).toBe("/Users/m/Library/Application Support/CorridorKey");
    expect(userDataDir("CorridorKey", { APPDATA: "C:\\Users\\m\\AppData\\Roaming" }, "C:\\Users\\m", "win32")).toMatch(/Roaming[\\/]CorridorKey$/);
  });

  it("takes run [--keep-going] FILE, as the CLI passes it", () => {
    expect(headlessArgs(["run", "nightly.ckcmd"])).toEqual({ file: "nightly.ckcmd", keepGoing: false });
    expect(headlessArgs(["run", "--keep-going", "a b.ckcmd"])).toEqual({ file: "a b.ckcmd", keepGoing: true });
    expect(headlessArgs(["render", "x"])).toEqual({ error: expect.stringMatching(/^usage/) });
    expect(headlessArgs(["run"])).toEqual({ error: expect.stringMatching(/^usage/) });
  });

  it("prints each block's new lines once (errors on stderr), a listing when it ends, the progress every 10 %, a failure's end", () => {
    const out: [string, string][] = [];
    const p = new Printer((s, t) => out.push([s, t]));
    p.block(block({ lines: [{ kind: "info", text: "nightly.ckcmd:1  dir" }] }));
    p.block(
      block({
        lines: [
          { kind: "info", text: "nightly.ckcmd:1  dir" },
          { kind: "err", text: "stopped at line 2" },
        ],
      }),
    );
    p.block(block({ id: 2, parent: 1, line: "render a.mov -o out", progress: { percent: 12, done: 12, total: 100 } }));
    p.block(block({ id: 2, parent: 1, line: "render a.mov -o out", progress: { percent: 15, done: 15, total: 100 } }));
    p.block(block({ id: 3, parent: 1, line: "dir", state: "done", entries: [{ name: "a.mov", folder: false, bytes: 2048, modified: null, sequence: null }] }));
    p.block(
      block({
        state: "failed",
        exitCode: 4,
        lines: [
          { kind: "info", text: "nightly.ckcmd:1  dir" },
          { kind: "err", text: "stopped at line 2" },
        ],
      }),
    );
    expect(out).toEqual([
      ["out", "nightly.ckcmd:1  dir"],
      ["err", "stopped at line 2"],
      ["out", "render a.mov -o out: 12/100 frames"],
      ["out", "Name   Size        Modified"],
      ["out", "a.mov  2.0 KiB"],
      ["err", "run nightly.ckcmd: failed (exit 4)"],
    ]);
  });

  it("stops on each stop line ck-cli writes on its stdin (Windows Ctrl+C), across chunks; other lines do nothing", async () => {
    const input = new PassThrough();
    let stops = 0;
    onStopLines(input, () => stops++);
    input.write("hello\nst");
    input.write("op\r\n");
    input.write(`${STOP_LINE}\n`);
    input.end();
    await new Promise((r) => input.on("end", r));
    await new Promise((r) => setImmediate(r));
    expect(stops).toBe(2);
  });

  it("refuses in words, with the next free version only where it fits (not for allow)", () => {
    expect(refusal("a.ckcmd's line that replaces files", true)).toMatch(
      /^a\.ckcmd's line that replaces files: .*Console \(or write into the next free version, -o …_v###\/, which replaces nothing\)$/,
    );
    expect(refusal("allow /mnt/show", false)).toBe("allow /mnt/show: a script run outside the app has no one to confirm it; run it in the app's Console");
  });
});
