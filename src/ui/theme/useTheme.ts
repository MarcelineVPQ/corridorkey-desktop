// Applies App settings → Appearance to the page. Light/dark comes from
// prefers-color-scheme (main sets nativeTheme.themeSource); the Desktop theme
// and the desktop accent write their tokens on :root (palette.ts) and remove
// them again when switched off. Runs only when those inputs change: the palette by value (every state push brings
// a new copy of the same palette).
import { useEffect } from "react";
import type { Appearance } from "../../shared/types";
import { accentVars, paletteToCssVars, type DesktopPalette, type Rgb } from "./palette";

// cache: OK — key=none (the tokens this hook set); invalidated=on every apply; bound=one token set
let applied: string[] = [];

export function useTheme(appearance: Appearance, palette: DesktopPalette | null): void {
  const paletteKey = palette ? JSON.stringify(palette) : null;
  useEffect(() => {
    const root = document.documentElement;
    // loop: NOT-WORTH — ≤ 20 tokens, on an appearance or desktop color change only
    for (const k of applied) root.style.removeProperty(k);
    applied = [];
    let vars: Record<string, string> = {};
    if (palette && appearance.theme === "desktop") vars = paletteToCssVars(palette);
    else if (palette && appearance.accent === "desktop") {
      const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      const grounds: Rgb[] = dark
        ? [
            [22, 24, 29],
            [29, 32, 39],
            [37, 41, 50],
          ]
        : [
            [243, 244, 247],
            [255, 255, 255],
            [236, 238, 242],
          ]; // theme-exempt: the built-in surfaces (tokens.css --bg-0..2)
      vars = accentVars(palette.accent, grounds, dark);
    }
    // loop: NOT-WORTH — ≤ 20 tokens, on an appearance or desktop color change only
    for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
    applied = Object.keys(vars);
    root.dataset.glass = appearance.glass ? "on" : "off";
    // palette: read from this render, which paletteKey says is a new value
  }, [appearance.theme, appearance.accent, appearance.glass, paletteKey]);
}
