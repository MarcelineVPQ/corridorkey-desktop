import { describe, expect, it } from "vitest";
import { checkAll, checkFile, codeOnly, sharedTexts } from "../../tools/check_texts.mjs";

const TEXTS = sharedTexts('export const ENGINE_FAILED = "The engine didn\'t start";\nexport const AS_USED =\n  "As used for this run";\nexport const f = (n: number) => `x ${n}`;\n');

describe("the shared-sentence gate", () => {
  it("passes on this repository", () => {
    expect(checkAll()).toEqual([]);
  });

  it("reads texts.ts's plain strings only", () => {
    expect(TEXTS).toEqual([
      { name: "ENGINE_FAILED", text: "The engine didn't start" },
      { name: "AS_USED", text: "As used for this run" },
    ]);
  });

  it("a sentence written again fails, as written or lower-cased (trtPrebuild.ts before 2026-10-27)", () => {
    const old = "note: `The engine didn't start: ${(e as Error).message}`";
    expect(checkFile("electron/main/trtPrebuild.ts", old, TEXTS)).toEqual([expect.stringContaining("use ENGINE_FAILED")]);
    expect(checkFile("a.ts", 'msg = "stopped: the engine didn\'t start"', TEXTS)).toEqual([expect.stringContaining("use ENGINE_FAILED")]);
    expect(checkFile("a.ts", "note: `${ENGINE_FAILED}: ${m}`", TEXTS)).toEqual([]);
  });

  it("comments don't count; URLs in strings stay code", () => {
    expect(checkFile("Section.tsx", '// a locked section\'s reason (a clip that ran: "As used for this run")\n{/* As used for this run */}', TEXTS)).toEqual([]);
    expect(codeOnly('const u = "https://x.org/a"; // note')).toBe('const u = "https://x.org/a"; ');
  });
});
