// The Console page's view model (src/ui/console/model.ts): the line's colours, the blocks as shown.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "../../src/shared/console/parse";
import { makeRegistry } from "../../src/shared/console/registry";
import {
  announcement,
  blockStatus,
  blockText,
  clearScreen,
  duration,
  errorSpans,
  highlight,
  mergeBlocks,
  isoTime,
  sequenceText,
  visibleBlocks,
  writtenPaths,
  BLOCKS_KEPT,
} from "../../src/ui/console/model";
import type { ConsoleBlock } from "../../src/shared/types";
import { fileSizeText as sizeText } from "../../src/shared/units";

const reg = makeRegistry();
const opts = { windows: false };
const hl = (line: string) => highlight(line, parse(line, reg, opts));
const kinds = (line: string) => hl(line).map((s) => [s.text, s.kind]);

const block = (id: number, extra: Partial<ConsoleBlock> = {}): ConsoleBlock => ({
  id,
  line: `info`,
  parent: null,
  cwd: "/home/m",
  argv: null,
  elevated: false,
  state: "done",
  exitCode: 0,
  exitMeaning: "done",
  startedAt: 1000,
  finishedAt: 1400,
  progress: null,
  status: null,
  lines: [],
  linesDropped: 0,
  entries: null,
  errors: [],
  clear: false,
  ...extra,
});

describe("the line's colours", () => {
  it("covers every character once, in order", () => {
    // loop: NOT-WORTH — a few lines in a test
    for (const line of ["render  shot.mov -o 'my out/' --overwrite", "  helpp", 'cd "unterminated', "sudo render a.mov --overwrite", ""])
      expect(
        hl(line)
          .map((s) => s.text)
          .join(""),
      ).toBe(line);
  });

  it("marks commands, flags, paths, mistakes (before Enter) and the destructive flag", () => {
    expect(kinds("render shot.mov -o out/")).toEqual([
      ["render", "command"],
      [" ", "plain"],
      ["shot.mov", "path"],
      [" ", "plain"],
      ["-o", "flag"],
      [" ", "plain"],
      ["out/", "path"],
    ]);
    const unknown = hl("rendr x");
    expect(unknown[0]).toMatchObject({ text: "rendr", kind: "error" });
    expect(unknown[0].title).toContain("did you mean render");
    expect(hl("render a.mov --colour x").find((s) => s.text === "--colour")?.kind).toBe("error");
    expect(hl("render a.mov --overwrite").find((s) => s.text === "--overwrite")?.kind).toBe("danger");
    expect(hl("sudo render a.mov --overwrite")[0]).toMatchObject({ text: "sudo", kind: "danger" });
  });

  it("a refused block's line is marked at its mistakes", () => {
    expect(errorSpans("rendr x", [{ start: 0, end: 5, message: "unknown" }])).toEqual([
      { text: "rendr", kind: "error", title: "unknown" },
      { text: " x", kind: "plain" },
    ]);
    expect(errorSpans("info", [])).toEqual([{ text: "info", kind: "plain" }]);
  });
});

describe("the blocks", () => {
  it("merge by id, in the order typed, keeping the newest BLOCKS_KEPT", () => {
    let l = mergeBlocks({ blocks: [], clearedTo: 0 }, [block(2), block(1)]);
    expect(l.blocks.map((b) => b.id)).toEqual([1, 2]);
    l = mergeBlocks(l, [block(2, { state: "failed" })]);
    expect(l.blocks).toHaveLength(2);
    expect(l.blocks[1].state).toBe("failed");
    // loop: NOT-WORTH — a test's blocks
    const many = Array.from({ length: BLOCKS_KEPT + 5 }, (_, i) => block(i + 1));
    expect(mergeBlocks({ blocks: [], clearedTo: 0 }, many).blocks[0].id).toBe(6);
  });

  it("cls clears what came before it (and isn't shown itself)", () => {
    const l = mergeBlocks({ blocks: [], clearedTo: 0 }, [block(1), block(2, { line: "cls", clear: true }), block(3)]);
    expect(visibleBlocks(l).map((b) => b.id)).toEqual([3]);
  });

  it("Ctrl+L clears at a block's edge: a running block stays whole", () => {
    const l = clearScreen(mergeBlocks({ blocks: [], clearedTo: 0 }, [block(1), block(2, { state: "running", finishedAt: null })]));
    expect(visibleBlocks(l).map((b) => b.id)).toEqual([2]);
    expect(visibleBlocks(mergeBlocks(l, [block(3)])).map((b) => b.id)).toEqual([2, 3]);
  });

  it("status words, the exit code and its meaning", () => {
    expect(blockStatus(block(1))).toEqual({ word: "done", tone: "ok", exit: "exit 0", meaning: null });
    expect(blockStatus(block(1, { state: "failed", exitCode: 4, exitMeaning: "output: the folder isn't writable" }))).toEqual({
      word: "failed",
      tone: "error",
      exit: "exit 4",
      meaning: "output: the folder isn't writable",
    });
    expect(blockStatus(block(1, { state: "cancelled", exitCode: 143, exitMeaning: "stopped, cleanly" })).word).toBe("stopped");
    expect(blockStatus(block(1, { state: "running", exitCode: null })).exit).toBeNull();
    expect(blockStatus(block(1, { state: "refused", exitCode: null })).tone).toBe("error");
  });

  it("duration", () => {
    expect(duration(block(1))).toBe("0.4 s");
    expect(duration(block(1, { finishedAt: 1000 + 125_000 }))).toBe("2 min 05 s");
    expect(duration(block(1, { finishedAt: null }))).toBeNull();
  });

  it("the paths a render wrote (not the Console's own temp folder)", () => {
    const b = block(1, { argv: ["render", "--temp", "/c/tmp", "--progress-format", "json", "-o", "/r/out", "--report", "/r/rep.json", "--", "-o"] });
    expect(writtenPaths(b, reg)).toEqual([
      { flag: "-o", path: "/r/out" },
      { flag: "--report", path: "/r/rep.json" },
    ]);
    expect(writtenPaths(block(2), reg)).toEqual([]);
  });

  it("Copy output: the lines, and a listing's rows", () => {
    const b = block(1, {
      lines: [
        { kind: "out", text: "a" },
        { kind: "err", text: "b" },
      ],
      entries: [
        { name: "plates", folder: true, bytes: null, modified: null, sequence: null },
        { name: "a.mov", folder: false, bytes: 2048, modified: null, sequence: null },
      ],
    });
    expect(blockText(b).split("\n")).toEqual(["a", "b", "Name     Size        Modified", "plates/  folder", "a.mov    2.0 KiB"]);
  });

  it("sizes", () => {
    expect(sizeText(null)).toBe("?");
    expect(sizeText(512)).toBe("512 B");
    expect(sizeText(1536)).toBe("1.5 KiB");
    expect(sizeText(5 * 1024 ** 3)).toBe("5.0 GiB");
    expect(sizeText(300 * 1024 ** 2)).toBe("300 MiB");
  });
});

describe("screen readers (review 2026-10-26 S8)", () => {
  it("announce only a command's start and end, never its streamed lines or a listing's rows", () => {
    expect(announcement([])).toBe("");
    expect(announcement([block(1, { line: "render shot.mov", state: "running", exitCode: null, lines: [{ kind: "out", text: "frame 1" }] })])).toBe("render shot.mov: running");
    // a new line of output or progress doesn't change what is said
    expect(announcement([block(1, { line: "render shot.mov", state: "running", exitCode: null, progress: { percent: 40, done: 4, total: 10 }, lines: [{ kind: "out", text: "frame 2" }] })])).toBe(
      "render shot.mov: running",
    );
    expect(announcement([block(1), block(2, { line: "render a.mov", state: "failed", exitCode: 6, exitMeaning: "out of graphics memory" })])).toBe(
      "render a.mov: failed, exit 6 (out of graphics memory)",
    );
    expect(announcement([block(3, { line: "render a.mov --overwrite", state: "refused", exitCode: null, lines: [{ kind: "err", text: "--overwrite replaces files" }] })])).toBe(
      "render a.mov --overwrite: refused: --overwrite replaces files",
    );
    expect(announcement([block(4, { line: "ls", entries: [{ name: "a", folder: false, bytes: 1, modified: 1, sequence: null }] })])).toBe("ls: done, exit 0");
  });

  it("the output isn't a live region; one polite status region carries the announcements", () => {
    const page = readFileSync(new URL("../../src/ui/pages/ConsolePage.tsx", import.meta.url), "utf8");
    expect(page).not.toMatch(/role="log"|aria-live="(polite|assertive)"[^>]*console-out/);
    expect(page).toMatch(/role="status"[^>]*>\s*\{announcement\(/);
  });
});

describe("SME review 2026-10-26: sequences in a listing (S1)", () => {
  it("a sequence row says its range, frame count and gaps", () => {
    expect(sequenceText({ range: "1001-1100", count: 96, missing: "1047, 1050-1052" })).toBe("1001-1100 · 96 frames · missing 1047, 1050-1052");
    expect(sequenceText({ range: "1-2", count: 2, missing: null })).toBe("1-2 · 2 frames");
  });
});

describe("SME review 2026-10-26: dates and sizes for pros (S8)", () => {
  it("dates are ISO-style local time, YYYY-MM-DD HH:MM (sortable, unambiguous across studios)", () => {
    const ms = new Date(2026, 9, 6, 9, 5, 7).getTime();
    expect(isoTime(ms)).toBe("2026-10-06 09:05");
    expect(isoTime(null)).toBe("");
  });

  it("Copy output has the table's columns: name, human size, the same date", () => {
    const ms = new Date(2026, 9, 26, 22, 58).getTime();
    const b = block(1, {
      lines: [{ kind: "out", text: "/shots: 3 files (2.0 GiB)" }],
      entries: [
        { name: "sh010_plate.####.exr", folder: false, bytes: 2 * 1024 ** 3, modified: ms, sequence: { range: "1001-1100", count: 100, missing: null } },
        { name: "notes.txt", folder: false, bytes: 12, modified: ms, sequence: null },
      ],
    });
    expect(blockText(b).split("\n")).toEqual([
      "/shots: 3 files (2.0 GiB)",
      "Name                                          Size        Modified",
      "sh010_plate.####.exr  1001-1100 · 100 frames  2.0 GiB     2026-10-26 22:58",
      "notes.txt                                     12 B        2026-10-26 22:58",
    ]);
  });
});
