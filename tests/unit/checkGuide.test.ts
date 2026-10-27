import { describe, expect, it } from "vitest";
import { checkAll, inGuide, sectionTitles } from "../../tools/check_guide.mjs";

// GUIDE.md before 2026-10-27: no Updates chapter and no word on where results go.
const OLD_GUIDE = "# Guide\n\n## Hints\n\n## Frame folders\n\n## Storage\n\nApp settings → Storage lists… **App settings → Console** removes each one.";

describe("the guide gate", () => {
  it("passes on this repository", () => {
    expect(checkAll()).toEqual([]);
  });

  it("reads literal section titles, across lines, and skips computed ones", () => {
    const tsx = '<Section id="hint" icon={Wand2} title="Hint" status={s}>\n<Section\n  id="results"\n  icon={F}\n  title="Results"\n>\n<Section key={id} title={DOCS[id].title}>';
    expect(sectionTitles(tsx)).toEqual(["Hint", "Results"]);
  });

  it("a section with no heading or bold mention fails (the old guide: Updates, Results)", () => {
    expect(inGuide(OLD_GUIDE, "Hint")).toBe(true);
    expect(inGuide(OLD_GUIDE, "Frame folder")).toBe(true);
    expect(inGuide(OLD_GUIDE, "Console")).toBe(true);
    expect(inGuide(OLD_GUIDE, "Updates")).toBe(false);
    expect(inGuide(OLD_GUIDE, "Results")).toBe(false);
    // a bold phrase counts only as whole words
    expect(inGuide("**Consoles**", "Console")).toBe(false);
  });
});
