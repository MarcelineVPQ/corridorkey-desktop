// The Console page's view model (src/ui/console/model.ts): the line's colours, the blocks as shown.
import { readFileSync } from "node:fs";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { parse } from "../../src/shared/console/parse";
import { makeRegistry } from "../../src/shared/console/registry";
import {
  announcement,
  blockStatus,
  childOpens,
  childRow,
  blockText,
  clearScreen,
  compactBlock,
  duration,
  errorSpans,
  expansionHint,
  highlight,
  inputTakesFocus,
  mergeBlocks,
  isoTime,
  lineHint,
  sequenceCell,
  sequenceText,
  visibleBlocks,
  writtenPaths,
  BLOCKS_KEPT,
  doctorText,
  shortenKnown,
} from "../../src/ui/console/model";
import type { ConsoleBlock } from "../../src/shared/types";
import type { Registry } from "../../src/shared/console/registry";

// the page's component, rendered to markup (the tests' typecheck has no JSX: loaded by a path it doesn't follow)
const { OutputBlock } = (await import("../../src/ui/console/OutputBlock" as string)) as {
  OutputBlock: ComponentType<{ b: ConsoleBlock; registry: Registry; onReinsert: (line: string) => void }>;
};
const { LineEditor } = (await import("../../src/ui/console/LineEditor" as string)) as { LineEditor: ComponentType<Record<string, unknown>> };
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

  it("the input names the completion list only while it is shown (review 2026-10-26 N7, BACKLOG row 112)", () => {
    const noop = () => {};
    const html = renderToStaticMarkup(
      createElement(LineEditor, {
        registry: reg,
        windows: false,
        history: [],
        past: [],
        running: false,
        elevated: false,
        folder: "m",
        mode: "list",
        autosuggest: false,
        onMode: noop,
        onRun: noop,
        onRunLines: noop,
        onCancel: noop,
        onClear: noop,
      }),
    );
    expect(html).toMatch(/role="combobox"/);
    expect(html).not.toMatch(/aria-controls=/);
    expect(html).not.toMatch(/role="listbox"/);
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

describe("SME review 2026-10-26: quieter blocks (S9)", () => {
  it("a built-in's block is compact; a corridorkey run's isn't", () => {
    expect(compactBlock(block(1, { line: "pwd" }))).toBe(true);
    expect(compactBlock(block(2, { argv: ["render", "--", "a.mov"] }))).toBe(false);
    expect(compactBlock(block(3, { progress: { percent: 1, done: 1, total: 100 } }))).toBe(false);
  });

  it("the block's buttons show on hover and on keyboard focus (never hidden from Tab), always without hover", () => {
    const css = readFileSync(new URL("../../src/styles/app.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.cb-actions \{[^}]*opacity: 0;/);
    expect(css).toMatch(/\.cblock:hover \.cb-actions,\s*\.cblock:focus-within \.cb-actions \{\s*opacity: 1;/);
    expect(css).toMatch(/@media \(hover: none\) \{\s*\.cb-actions \{\s*opacity: 1;/);
    // display: none / visibility: hidden would take them out of the keyboard's reach
    expect(css).not.toMatch(/\.cb-actions \{[^}]*(display: none|visibility: hidden)/);
  });
});

describe("SME review 2026-10-26: the sudo hint (S11)", () => {
  it("says (needs sudo) on a flag that replaces files only until sudo is on the line", () => {
    const at = (line: string) => lineHint(parse(line, reg, opts), line, line.length, reg, false)?.text;
    expect(at("render a.mov -o out/ --overwrite")).toMatch(/\(needs sudo\)$/);
    expect(at("sudo render a.mov -o out/ --overwrite")).not.toMatch(/needs sudo/);
  });
});

describe("teach by echo: a queue job's line", () => {
  const echo = block(5, { line: "corridorkey render -i a.mov -o /out/a", exitCode: null, exitMeaning: null, echo: "The queue started a.mov; as a command line:" });

  it("reads as where it came from, with no exit code", () => {
    expect(blockStatus(echo)).toEqual({ word: "from the queue", tone: "ok", exit: null, meaning: null });
    expect(announcement([echo])).toBe("corridorkey render -i a.mov -o /out/a: from the queue");
    // it ran nothing here: no duration
    expect(duration(echo)).toBeNull();
  });

  it("is shown unless Console settings turn GUI jobs as commands off", () => {
    const list = mergeBlocks({ blocks: [], clearedTo: 0 }, [block(4), echo]);
    expect(visibleBlocks(list).map((b) => b.id)).toEqual([4, 5]);
    expect(visibleBlocks(list, false).map((b) => b.id)).toEqual([4]);
  });
});

describe("history shortcuts in the hint", () => {
  const past = [
    { n: 7, line: "render a.mov -o out/ --overwrite" },
    { n: 8, line: "dir out" },
  ];
  it("says what Enter will run, or why it can't; a line without a shortcut has no such hint", () => {
    expect(expansionHint("sudo !-2", past, false)).toEqual({ text: "Enter runs: sudo render a.mov -o out/ --overwrite", error: false, line: "sudo render a.mov -o out/ --overwrite" });
    expect(expansionHint("!9", past, false)).toEqual({ text: "!9: no line 9 in the history (history lists the numbers)", error: true, line: null });
    expect(expansionHint("render sh010!.mov", past, false)).toBeNull();
  });
});

describe("variables in the typed line", () => {
  it("a value with ${name} is checked once filled in: never marked a mistake as typed", () => {
    expect(kinds("render a.mov -F ${range}")).toContainEqual(["${range}", "value"]);
    expect(lineHint(parse("render a.mov -F ${range}", reg, opts), "render a.mov -F ${range}", 3, reg, false)?.error).toBe(false);
    // a real mistake still is
    expect(kinds("render a.mov -F abc")).toContainEqual(["abc", "error"]);
  });
});

describe("layout polish: long paths and doctor's table (Phase 4)", () => {
  const home = "/home/marcy";
  it("shortens a block's known paths as the app shows paths: ~, the middle as …; other text untouched", () => {
    const dir = "/home/marcy/.cache/claude-scratch/ck-console-p4a/iso/home/shots/sh010/plates";
    const line = `${dir}: 43 files (2.7 KiB), 43 of them in 1 sequence (dir -f lists the frames), 0 folders`;
    const short = shortenKnown(line, [dir], home);
    expect(short).toBe("~/…/ck-console-p4a/iso/home/shots/sh010/plates: 43 files (2.7 KiB), 43 of them in 1 sequence (dir -f lists the frames), 0 folders");
    expect(shortenKnown("/home/marcy/renders: 1 files", ["/home/marcy/renders"], home)).toBe("~/renders: 1 files");
    expect(shortenKnown("no path here", [dir], home)).toBe("no path here");
    expect(shortenKnown("x", null, home)).toBe("x");
    // a path inside a longer one is left to the longer one
    const sh = "/home/marcy/shots/a-long-show-name/sequence-010/sh010";
    expect(shortenKnown(`0  ${sh}/plates/and/more/folders`, [sh, `${sh}/plates/and/more/folders`], home)).toBe("0  ~/…/sequence-010/sh010/plates/and/more/folders");
    expect(shortenKnown(`1  ${sh}`, [sh, `${sh}/plates/and/more/folders`], home)).toBe("1  ~/shots/a-long-show-name/sequence-010/sh010");
    // Copy output keeps the whole path
    expect(blockText(block(1, { lines: [{ kind: "out", text: line }], paths: [dir] }))).toBe(line);
  });

  it("doctor's rows as aligned text (Copy output), the fix under its detail, paths whole", () => {
    const rows = [
      { check: "corridorkey", status: "ok" as const, detail: "/opt/ck/corridorkey", fix: null, path: "/opt/ck/corridorkey" },
      { check: "Models", status: "fail" as const, detail: "/m has no rvm network", fix: "App: Engine page", path: "/m" },
      { check: "TensorRT", status: "warn" as const, detail: "on, not downloaded", fix: "App: Engine page → TensorRT" },
    ];
    expect(doctorText(rows)).toEqual([
      "✓ corridorkey  /opt/ck/corridorkey",
      "✗ Models       /m has no rvm network",
      "               fix: App: Engine page",
      "⚠ TensorRT     on, not downloaded",
      "               fix: App: Engine page → TensorRT",
    ]);
    expect(blockText(block(1, { lines: [{ kind: "out", text: "3 checks: 1 ok, 1 warning, 1 problem" }], doctor: rows })).split("\n")[1]).toBe("✓ corridorkey  /opt/ck/corridorkey");
  });
});

// SME review 2026-10-27 S8 (screenshot for-sequence.png): every iteration of a loop was a full block (header, state,
// exit code, time, three buttons, a "from" line), about 100 px for one line of output
describe("a program's commands are one row each (review 2026-10-27 S8)", () => {
  const kid = (extra: Partial<ConsoleBlock>) =>
    block(7, {
      parent: 3,
      line: 'echo "a.exr"',
      lines: [
        { kind: "info", text: "from echo ${f}" },
        { kind: "out", text: "a.exr" },
      ],
      ...extra,
    });
  const html = (b: ConsoleBlock) => renderToStaticMarkup(createElement(OutputBlock, { b, registry: reg, onReinsert: () => {} }));

  it("a done command is one row: a button (keyboard reachable, collapsed) with its mark, line, time and last output line", () => {
    expect(childRow(kid({}), "/home/m")).toEqual({ mark: "✓", last: "a.exr", full: "a.exr", source: "from echo ${f}" });
    expect([childOpens(kid({})), childOpens(kid({ state: "cancelled" }))]).toEqual([false, false]);
    const h = html(kid({}));
    expect(h).toMatch(/^<article class="cblock child row tone-ok"/);
    expect(h).toMatch(/<button type="button" class="cb-row" aria-expanded="false"/);
    expect(h).toContain("a.exr");
    expect(h).toContain("0.4 s");
    // none of the full block's chrome
    expect(h).not.toMatch(/cb-actions|Copy command/);
  });

  // Marcy's screenshots 2026-10-27 (02-for-loop-collapsed.png): a loop's rows showed the folder whole
  // (/home/…/plates: 124 files…), and a filled-in line (cd "@sh010") without what was typed
  it("a row's last line shows its known paths as the blocks do (~, the middle as …), whole on hover", () => {
    const dir = "/home/m/.cache/claude-scratch/ck-wikigate/iso/home/shots/sh010/plates";
    const text = `${dir}: 124 files (12 B), 123 of them in 2 sequences (dir -f lists the frames), 0 folders`;
    const ls = kid({ line: "ls plates", lines: [{ kind: "out", text }], paths: [dir] });
    const row = childRow(ls, "/home/m");
    expect(row.last).toBe("~/…/ck-wikigate/iso/home/shots/sh010/plates: 124 files (12 B), 123 of them in 2 sequences (dir -f lists the frames), 0 folders");
    expect(row.full).toBe(text);
    expect(row.source).toBeNull();
  });

  it("a filled-in line's row shows it as it ran and what was typed (the block's from line)", () => {
    const cd = kid({ line: 'cd "@sh010"', lines: [{ kind: "info", text: "from cd @${s}" }] });
    expect(childRow(cd, "/home/m")).toEqual({ mark: "✓", last: null, full: null, source: "from cd @${s}" });
    const h = html(cd);
    expect(h).toContain("cd &quot;@sh010&quot;");
    expect(h).toMatch(/class="cb-row-from">from cd @\$\{s\}</);
    // a line typed as it ran has no source
    expect(childRow(kid({ line: "ls plates", lines: [] }), "/home/m").source).toBeNull();
  });

  it("one that runs, failed or was refused shows whole on its own, with a Collapse button; a top-level block never folds", () => {
    // loop: NOT-WORTH — three states
    for (const state of ["running", "failed", "refused"] as const) {
      expect(childOpens(kid({ state }))).toBe(true);
      const h = html(kid({ state, exitCode: state === "failed" ? 1 : null }));
      expect(h, state).toMatch(/class="cb-collapse" aria-expanded="true"/);
      expect(h, state).toContain("Copy command");
    }
    expect(childRow(kid({ state: "failed" }), "/home/m").mark).toBe("✗");
    expect(html(block(1))).not.toMatch(/cb-row|cb-collapse/);
  });
});

describe("the input line's focus beside the narrow-window drawer", () => {
  it("takes focus when the page opens uncovered and when the drawer over it closes", () => {
    expect(inputTakesFocus(null, false)).toBe(true);
    expect(inputTakesFocus(true, false)).toBe(true);
  });
  it("never takes focus while the drawer covers it (the page opened from the rail opens with its drawer)", () => {
    expect(inputTakesFocus(null, true)).toBe(false);
    expect(inputTakesFocus(false, true)).toBe(false);
  });
  it("leaves focus alone when nothing about the drawer changed", () => {
    expect(inputTakesFocus(false, false)).toBe(false);
  });
});

describe("SME review 2026-10-27: the expert suggestions", () => {
  it("P4 N5 (row 144): dir's cell says 43/48 frames, the gaps on hover; Copy output keeps them; a pre-roll is said", () => {
    const q = { range: "1001-1048", count: 43, missing: "1012-1015, 1040", gaps: "1012-1015, 1040", span: 48 };
    expect(sequenceCell(q)).toEqual({ text: "1001-1048 · 43/48 frames", title: "missing 1012-1015, 1040" });
    expect(sequenceCell({ range: "1-2", count: 2, missing: null, span: 2 })).toEqual({ text: "1-2 · 2 frames", title: null });
    expect(sequenceText(q)).toBe("1001-1048 · 43 frames · missing 1012-1015, 1040");
    expect(sequenceCell({ range: "-10-20", count: 31, missing: null, span: 31, belowZero: 10 }).text).toBe("-10-20 · 31 frames · 10 below 0 (corridorkey's patterns and -F start at 0)");
  });
});
