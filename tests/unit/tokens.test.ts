// The built-in theme's contrast (WCAG 2.x), computed from src/styles/tokens.css itself so a token change can't
// quietly drop a text color below 4.5:1 on a surface it sits on (UI pass 2026-10-25, Marcy). Grounds: the four
// surfaces and the tinted ones (the selected clip's row, the warning and error notices) over the page and the panels.
// The one green (Marcy 2026-10-25, "the green should only be this green"): the app icon's green, #00b140, measured
// from build/icon.png, in both themes; any other green in tokens.css fails here.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contrast, type Rgb } from "../../src/ui/theme/palette";

const CSS = readFileSync(new URL("../../src/styles/tokens.css", import.meta.url), "utf8");

type Tokens = Record<string, { rgb: Rgb; alpha: number }>;

function block(src: string, base: Tokens = {}): Tokens {
  const out: Tokens = { ...base };
  // loop: NOT-WORTH — one theme block's few dozen declarations, once per test run
  for (const m of src.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    const v = m[2].trim();
    const ref = /^var\((--[\w-]+)\)$/.exec(v);
    const hex = /^#([0-9a-f]{6})$/i.exec(v);
    const rgba = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(v);
    if (ref && out[ref[1]]) out[m[1]] = out[ref[1]];
    else if (hex) out[m[1]] = { rgb: [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)) as Rgb, alpha: 1 };
    else if (rgba) out[m[1]] = { rgb: [Number(rgba[1]), Number(rgba[2]), Number(rgba[3])], alpha: rgba[4] === undefined ? 1 : Number(rgba[4]) };
  }
  return out;
}

const darkSrc = CSS.slice(0, CSS.indexOf("@media"));
const lightSrc = CSS.slice(CSS.indexOf("@media"));
const THEMES: [string, Tokens][] = [
  ["dark", block(darkSrc)],
  ["light", block(lightSrc, block(darkSrc))],
];

const over = (top: { rgb: Rgb; alpha: number }, under: Rgb): Rgb => top.rgb.map((c, i) => Math.round(c * top.alpha + under[i] * (1 - top.alpha))) as Rgb;
const hexOf = (rgb: Rgb) => "#" + rgb.map((c) => c.toString(16).padStart(2, "0")).join("");

const SURFACES = ["--bg-0", "--bg-1", "--bg-2", "--bg-3"];
const TINTS = ["--accent-soft", "--status-warn-soft", "--status-error-soft"];
// every token the CSS uses as the color of readable text (the green words, --accent-ink, have their own grounds
// below; --status-ok is a fill and a mark, never words)
const TEXT = ["--text-1", "--text-2", "--text-3", "--status-warn", "--status-error", "--status-info"];
// every token that paints green, in both themes
const GREEN_TOKENS = ["--accent", "--accent-strong", "--accent-soft", "--status-ok"];

describe("tokens.css, the one green", () => {
  it("holds no green but #00b140 (and #0b1f13, the dark ink on it)", () => {
    const others: string[] = [];
    // loop: NOT-WORTH — the file's few dozen colors, once per test run
    for (const m of CSS.matchAll(/#([0-9a-f]{6})\b|rgba?\((\d+),\s*(\d+),\s*(\d+)/gi)) {
      const rgb = (m[1] ? [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) : [Number(m[2]), Number(m[3]), Number(m[4])]) as Rgb;
      const greenish = rgb[1] > rgb[0] + 40 && rgb[1] > rgb[2] + 20;
      if (greenish && hexOf(rgb) !== "#00b140") others.push(hexOf(rgb));
    }
    expect(others).toEqual([]);
  });
});

describe.each(THEMES)("tokens.css, %s theme", (_name, t) => {
  const grounds: [string, Rgb][] = [
    // loop: NOT-WORTH — four surfaces
    ...SURFACES.map((s): [string, Rgb] => [s, t[s].rgb]),
    // the tints sit on the page and the panels (bg-0, bg-1): the selected clip, the notices
    // loop: NOT-WORTH — three tints over two surfaces
    ...TINTS.flatMap((tint) => ["--bg-0", "--bg-1"].map((s): [string, Rgb] => [`${tint} over ${s}`, over(t[tint], t[s].rgb)])),
  ];

  it.each(TEXT)("%s reads at 4.5:1 or better on every surface", (fg) => {
    // loop: NOT-WORTH — ten grounds
    const low = grounds.map(([g, rgb]) => [g, contrast(t[fg].rgb, rgb)] as const).filter(([, c]) => c < 4.5);
    expect(low.map(([g, c]) => `${g}: ${c.toFixed(2)}`)).toEqual([]);
  });

  it.each(GREEN_TOKENS)("%s is exactly the icon's green, #00b140", (k) => {
    expect(hexOf(t[k].rgb)).toBe("#00b140");
  });

  it("every green mark (the ✓ ink or fill, the link band) is #00b140", () => {
    // loop: NOT-WORTH — three tokens
    const green = ["--mark-fill", "--mark-ink", "--link-mark"].filter((k) => t[k].alpha > 0 && t[k].rgb[1] > t[k].rgb[0] + 40);
    expect(green.length).toBeGreaterThan(0);
    // loop: NOT-WORTH — at most three tokens
    for (const k of green) expect(hexOf(t[k].rgb)).toBe("#00b140");
  });

  it("text on the green (primary buttons, the chosen segment, step badges, the engine dot, the ✓ disc) is dark, 4.5:1 or better", () => {
    expect(hexOf(t["--accent-text"].rgb)).toBe("#0b1f13");
    // loop: NOT-WORTH — three fills
    for (const fill of ["--accent", "--accent-strong", "--status-ok"]) expect(contrast(t["--accent-text"].rgb, t[fill].rgb)).toBeGreaterThanOrEqual(4.5);
    if (t["--mark-fill"].alpha > 0) expect(contrast(t["--mark-ink"].rgb, t["--mark-fill"].rgb)).toBeGreaterThanOrEqual(4.5);
  });

  it("green words (--accent-ink) are #00b140 only where they read at 4.5:1, else the normal text color", () => {
    const ink = t["--accent-ink"].rgb;
    if (hexOf(ink) === "#00b140") {
      // dark: green words on bg-0..bg-2 and the green tint over the page and the panels; never on bg-3 (4.37:1)
      const inkGrounds: [string, Rgb][] = [
        // loop: NOT-WORTH — three surfaces
        ...["--bg-0", "--bg-1", "--bg-2"].map((s): [string, Rgb] => [s, t[s].rgb]),
        // loop: NOT-WORTH — two surfaces
        ...["--bg-0", "--bg-1"].map((s): [string, Rgb] => [`--accent-soft over ${s}`, over(t["--accent-soft"], t[s].rgb)]),
      ];
      // loop: NOT-WORTH — five grounds
      const low = inkGrounds.map(([g, rgb]) => [g, contrast(ink, rgb)] as const).filter(([, c]) => c < 4.5);
      expect(low.map(([g, c]) => `${g}: ${c.toFixed(2)}`)).toEqual([]);
      expect(contrast(ink, t["--bg-3"].rgb)).toBeLessThan(4.5); // why bg-3 is excluded: if this passes one day, add it back
    } else {
      // light: green words fail (2.85:1 on white), so they take the normal text color (checked on every ground above)
      expect(hexOf(ink)).toBe(hexOf(t["--text-1"].rgb));
      // and every green mark then has a dark edge
      expect(t["--mark-edge"].alpha).toBe(1);
    }
  });

  it("the green marks reach 3:1 against the surfaces they sit on (WCAG non-text contrast)", () => {
    // a mark's outer edge: the dark edge where there is one (light), else the green itself (dark)
    const edge = t["--mark-edge"].alpha > 0 ? t["--mark-edge"].rgb : t["--status-ok"].rgb;
    // loop: NOT-WORTH — three surfaces
    const low = ["--bg-0", "--bg-1", "--bg-2"].map((s) => [s, contrast(edge, t[s].rgb)] as const).filter(([, c]) => c < 3);
    expect(low.map(([g, c]) => `${g}: ${c.toFixed(2)}`)).toEqual([]);
  });

  it("keeps the hierarchy text-1 > text-2 > text-3, each step visibly apart", () => {
    // loop: NOT-WORTH — four surfaces
    for (const s of SURFACES) {
      const [c1, c2, c3] = ["--text-1", "--text-2", "--text-3"].map((k) => contrast(t[k].rgb, t[s].rgb));
      expect(c1 / c2).toBeGreaterThanOrEqual(1.3);
      expect(c2 / c3).toBeGreaterThanOrEqual(1.3);
    }
  });
});
