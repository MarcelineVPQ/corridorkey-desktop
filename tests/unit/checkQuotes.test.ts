import { describe, expect, it } from "vitest";
import { checkAll, checkFiles, notSpeech, SKIP } from "../../tools/check_quotes.mjs";

// made-up quotes in the shapes the repository had before 2026-10-30 (this file is in the gate's SKIP list)
const file = (name: string, ...lines: string[]) => ({ name, text: lines.join("\n") });

describe("the quotes gate", () => {
  it("passes on this repository", () => {
    expect(checkAll()).toEqual([]);
  });

  it("fails on the backlog's Source shape, a colon or said before a quote, and a quote on the next comment line", () => {
    const problems = checkFiles([
      file("docs/BACKLOG.md", '| 9 | A row | Marcy 2026-10-24 ("paint the shed blue on sunday") | idea |'),
      file("docs/NOTES.md", 'The plan (Marcy 2026-10-25: "keep the lights on all night") holds.', 'The owner said "bring the boat in early" once.'),
      file("src/a.ts", "// the panel (a note from Marcy", '// 2026-10-30: "bring every crate inside"), read here'),
    ]);
    expect(problems).toEqual([
      expect.stringContaining('docs/BACKLOG.md:1: quotes words next to Marcy or the owner ("paint the shed blue on sunday")'),
      expect.stringContaining('docs/NOTES.md:1: quotes words next to Marcy or the owner ("keep the lights on all night")'),
      expect.stringContaining('docs/NOTES.md:2: quotes words next to Marcy or the owner ("bring the boat in early")'),
      expect.stringContaining('src/a.ts:1: quotes words next to Marcy or the owner ("bring every crate inside")'),
    ]);
  });

  it("passes the decision in plain words, labels and titles, a quote in another sentence, and quote-ok", () => {
    expect(
      checkFiles([
        file("docs/BACKLOG.md", "| 9 | A row | Marcy 2026-10-24: the shed is painted blue | idea |"),
        file("docs/GUIDE.md", 'Marcy 2026-10-25: the button reads "Save Log As" and the panel says "last 12 of 74 lines".'),
        file("docs/NOTES.md", 'Marcy 2026-10-25 decided it. The app then says "the graphics card is busy here".', 'Marcy: the "untested" label stays.'),
        file("docs/OLD.md", 'Marcy 2026-10-25: never "the card is busy right now" again (quote-ok: the old app message)'),
        file("src/b.ts", "// row 12 (Marcy 2026-10-27)", 'const s = "a string of code: not words";'),
      ]),
    ).toEqual([]);
  });

  it("tells labels from speech", () => {
    expect(notSpeech("Optimizing for this Resolution")).toBe(true);
    expect(notSpeech("3.1 frames/s over the last 20 frames")).toBe(true);
    expect(notSpeech("untested")).toBe(true);
    expect(notSpeech("we need to ship it today")).toBe(false);
  });

  it("says why it skips each path", () => {
    for (const why of SKIP.values()) expect(why.length).toBeGreaterThan(10);
  });
});
