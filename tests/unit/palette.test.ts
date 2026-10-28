import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { accentText, accentVars, BUILTIN_GROUNDS, contrast, ensureContrast, paletteToCssVars, parseKdeGlobals, type Rgb } from "../../src/ui/theme/palette";

const TOKENS = readFileSync(new URL("../../src/styles/tokens.css", import.meta.url), "utf8");
const THEME_SRC = { dark: TOKENS.slice(0, TOKENS.indexOf("@media")), light: TOKENS.slice(TOKENS.indexOf("@media")) };
/** a theme block's declarations, name → value */
// loop: NOT-WORTH — one theme block's few dozen declarations, per test
const decls = (src: string) => new Map([...src.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
const hexRgb = (h: string): Rgb => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb;

const BREEZE_DARK = `[General]
AccentColor=61,174,233
[Colors:Window]
BackgroundNormal=32,35,38
ForegroundNormal=252,252,252
ForegroundInactive=161,169,177
[Colors:View]
BackgroundNormal=20,22,24
ForegroundNormal=252,252,252
[Colors:Button]
BackgroundNormal=41,44,48
ForegroundNormal=252,252,252
`;

const parse = (v: string): Rgb => v.match(/\d+/g)!.map(Number) as Rgb;

describe("Desktop theme", () => {
  it("reads a KDE scheme and keeps every text token ≥ 4.5:1 on every surface", () => {
    const p = parseKdeGlobals(BREEZE_DARK)!;
    expect(p.source).toBe("kde");
    expect(p.isDark).toBe(true);
    const v = paletteToCssVars(p);
    const grounds = ["--bg-1", "--bg-2"].map((k) => parse(v[k]));
    for (const t of ["--text-1", "--text-2", "--text-3", "--accent-ink"]) for (const g of grounds) expect(contrast(parse(v[t]), g)).toBeGreaterThanOrEqual(4.5);
  });
  it("an unusable file gives no palette", () => {
    expect(parseKdeGlobals("[General]\nfoo=bar\n")).toBeNull();
  });
  it("ensureContrast pushes only as far as needed", () => {
    const c = ensureContrast([120, 120, 120], [255, 255, 255], 4.5);
    expect(contrast(c, [255, 255, 255])).toBeGreaterThanOrEqual(4.5);
    expect(ensureContrast([0, 0, 0], [255, 255, 255], 4.5)).toEqual([0, 0, 0]);
  });
  it("whole review: the Appearance readout names the accent in use (the Desktop theme takes the desktop's)", () => {
    expect(accentText({ theme: "desktop", accent: "builtin" }, true)).toBe("desktop accent");
    expect(accentText({ theme: "dark", accent: "builtin" }, true)).toBe("built-in accent");
    expect(accentText({ theme: "dark", accent: "desktop" }, false)).toBe("built-in accent (no desktop colors found)");
  });

  it("review N9: the built-in surfaces the accent math uses are tokens.css's own --bg-0..2", () => {
    // loop: NOT-WORTH — two themes × three surfaces
    for (const theme of ["dark", "light"] as const) {
      const d = decls(THEME_SRC[theme]);
      expect(BUILTIN_GROUNDS[theme]).toEqual(["--bg-0", "--bg-1", "--bg-2"].map((k) => hexRgb(d.get(k)!)));
    }
  });
  it("review S2: a desktop accent overrides every token tokens.css derives from the built-in green (the marks too)", () => {
    // the built-in green and its dark ink; status colors keep their meaning (--status-ok)
    const green = /#00b140|#0b1f13|rgba\(0, 177, 64/i;
    // loop: NOT-WORTH — two themes
    for (const theme of ["dark", "light"] as const) {
      // loop: NOT-WORTH — one theme's few dozen tokens
      const derived = [...decls(THEME_SRC[theme])].filter(([k, v]) => green.test(v) && k !== "--status-ok").map(([k]) => k);
      expect(derived.length).toBeGreaterThan(3);
      const vars = accentVars([61, 174, 233], BUILTIN_GROUNDS[theme], theme === "dark");
      expect(derived.filter((k) => !(k in vars))).toEqual([]);
      // no green left in what it sets
      expect(Object.values(vars).filter((v) => /177, 64|\(0, 177/.test(v))).toEqual([]);
    }
  });
});
