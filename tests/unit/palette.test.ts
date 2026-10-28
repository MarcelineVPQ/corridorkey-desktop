import { describe, expect, it } from "vitest";
import { accentText, contrast, ensureContrast, paletteToCssVars, parseKdeGlobals, type Rgb } from "../../src/ui/theme/palette";

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
});
