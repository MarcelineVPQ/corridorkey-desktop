// Review N12: when the narrow drawer closed, focus went back only on the Console page (its own input line); on the
// other pages it was lost with the drawer's panel.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mainTakesFocus } from "../../src/ui/panel/drawerFocus";

describe("the narrow drawer's focus", () => {
  it("the main view takes focus when the drawer closes, not when the page opens or stays as it was", () => {
    expect(mainTakesFocus(true, false)).toBe(true);
    expect(mainTakesFocus(null, false)).toBe(false);
    expect(mainTakesFocus(false, false)).toBe(false);
    expect(mainTakesFocus(null, true)).toBe(false);
    expect(mainTakesFocus(false, true)).toBe(false);
  });

  it("SplitView, every page's layout, gives it focus then (a focusable main view)", () => {
    const src = readFileSync(new URL("../../src/ui/panel/SplitView.tsx", import.meta.url), "utf8");
    expect(src).toMatch(/mainTakesFocus\(wasDrawer\.current, drawer\)\) mainRef\.current\?\.focus\(\)/);
    expect(src).toContain('<div ref={mainRef} tabIndex={-1} className="split-main">');
  });
});
