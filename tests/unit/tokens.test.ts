// The built-in theme's contrast (WCAG 2.x), computed from src/styles/tokens.css itself so a token change can't
// quietly drop a text color below 4.5:1 on a surface it sits on (UI pass 2026-10-25, Marcy). Grounds: the four
// surfaces and the tinted ones (the selected clip's row, the warning and error notices) over the page and the panels.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contrast, type Rgb } from "../../src/ui/theme/palette";

const CSS = readFileSync(new URL("../../src/styles/tokens.css", import.meta.url), "utf8");

type Tokens = Record<string, { rgb: Rgb; alpha: number }>;

function block(src: string): Tokens {
  const out: Tokens = {};
  // loop: NOT-WORTH — one theme block's few dozen declarations, once per test run
  for (const m of src.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    const v = m[2].trim();
    const hex = /^#([0-9a-f]{6})$/i.exec(v);
    const rgba = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(v);
    if (hex) out[m[1]] = { rgb: [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)) as Rgb, alpha: 1 };
    else if (rgba) out[m[1]] = { rgb: [Number(rgba[1]), Number(rgba[2]), Number(rgba[3])], alpha: rgba[4] === undefined ? 1 : Number(rgba[4]) };
  }
  return out;
}

const darkSrc = CSS.slice(0, CSS.indexOf("@media"));
const lightSrc = CSS.slice(CSS.indexOf("@media"));
const THEMES: [string, Tokens][] = [
  ["dark", block(darkSrc)],
  ["light", { ...block(darkSrc), ...block(lightSrc) }],
];

const over = (top: { rgb: Rgb; alpha: number }, under: Rgb): Rgb => top.rgb.map((c, i) => Math.round(c * top.alpha + under[i] * (1 - top.alpha))) as Rgb;

const SURFACES = ["--bg-0", "--bg-1", "--bg-2", "--bg-3"];
const TINTS = ["--accent-soft", "--status-warn-soft", "--status-error-soft"];
// every token the CSS uses as the color of readable text
const TEXT = ["--text-1", "--text-2", "--text-3", "--accent-ink", "--status-ok", "--status-warn", "--status-error", "--status-info"];

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

  it("text on the accent (primary buttons, the chosen segment) reads at 4.5:1 or better", () => {
    expect(contrast(t["--accent-text"].rgb, t["--accent"].rgb)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t["--accent-text"].rgb, t["--accent-strong"].rgb)).toBeGreaterThanOrEqual(4.5);
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
