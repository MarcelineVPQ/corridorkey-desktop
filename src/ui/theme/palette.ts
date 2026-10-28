// The Desktop theme ("Match desktop"): the
// main process reads the desktop's colors (KDE's kdeglobals; elsewhere just
// the system accent) and this maps them onto the app's tokens (tokens.css).
// Pure functions, unit-tested (tests/unit/palette.test.ts). Every text token
// is pushed until it reads at 4.5:1 or better on the surfaces it sits on.

export type Rgb = [number, number, number];

export interface DesktopPalette {
  // "kde": a full color scheme. "accent": only an accent color (GNOME via the
  // portal, Windows, macOS), layered on the built-in light/dark theme.
  source: "kde" | "accent";
  isDark: boolean;
  accent: Rgb;
  window?: Rgb;
  windowText?: Rgb;
  view?: Rgb;
  viewText?: Rgb;
  button?: Rgb;
  buttonText?: Rgb;
  inactiveText?: Rgb;
}

type Ini = Record<string, Record<string, string>>;

function parseIni(text: string): Ini {
  const out: Ini = {};
  let section = "";
  // loop: NOT-WORTH — one pass over kdeglobals (a few hundred lines) when the desktop's colors change
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      section = header[1];
      out[section] ??= {};
      continue;
    }
    const eq = line.indexOf("=");
    if (eq > 0 && section) out[section][line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

function rgb(value: string | undefined): Rgb | undefined {
  const m = value?.match(/^(\d{1,3}),(\d{1,3}),(\d{1,3})/);
  if (!m) return undefined;
  const c = [Number(m[1]), Number(m[2]), Number(m[3])] as Rgb;
  // loop: NOT-WORTH — three channels per parsed colour
  return c.every((v) => v <= 255) ? c : undefined;
}

/** KDE's accent: [General] AccentColor, else the scheme's selection color. */
export function kdeAccent(text: string | Ini): Rgb | null {
  const ini = typeof text === "string" ? parseIni(text) : text;
  return rgb(ini.General?.AccentColor) ?? rgb(ini["Colors:Selection"]?.BackgroundNormal) ?? null;
}

/** Null when the file has no usable color scheme (e.g. a fresh account). */
export function parseKdeGlobals(text: string): DesktopPalette | null {
  const ini = parseIni(text);
  const win = ini["Colors:Window"] ?? {};
  const view = ini["Colors:View"] ?? {};
  const button = ini["Colors:Button"] ?? {};
  const window = rgb(win.BackgroundNormal);
  const windowText = rgb(win.ForegroundNormal);
  if (!window || !windowText) return null;
  const accent = kdeAccent(ini) ?? rgb(view.DecorationFocus) ?? ([61, 174, 233] as Rgb); // theme-exempt: Breeze blue, KDE's own default accent
  return {
    source: "kde",
    isDark: luminance(window) < 0.4,
    accent,
    window,
    windowText,
    view: rgb(view.BackgroundNormal) ?? window,
    viewText: rgb(view.ForegroundNormal) ?? windowText,
    button: rgb(button.BackgroundNormal) ?? window,
    buttonText: rgb(button.ForegroundNormal) ?? windowText,
    inactiveText: rgb(win.ForegroundInactive) ?? rgb(view.ForegroundInactive),
  };
}

// --- color math ---

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function luminance([r, g, b]: Rgb): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrast(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)];
}

const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];
export const wantsLightInk = (bg: Rgb) => contrast(WHITE, bg) >= contrast(BLACK, bg);

/** Push `fg` toward white or black until it reaches `target` on `bg` (keeps the hue; only as far as needed). */
export function ensureContrast(fg: Rgb, bg: Rgb, target: number, toward: Rgb = wantsLightInk(bg) ? WHITE : BLACK): Rgb {
  if (contrast(fg, bg) >= target) return fg;
  // loop: NOT-WORTH — ≤ 20 steps of arithmetic; on a theme change only
  for (let t = 0.05; t <= 1; t += 0.05) {
    const c = mix(fg, toward, t);
    if (contrast(c, bg) >= target) return c;
  }
  return toward;
}

/** `fg` pushed toward `ink` until it reaches `target` on every ground. */
export function legibleOnAll(fg: Rgb, grounds: Rgb[], target: number, ink: Rgb): Rgb {
  let c = fg;
  // loop: NOT-WORTH — ≤ 5 passes × ≤ 4 grounds; on a theme change only
  for (let i = 0; i < 5 && grounds.some((g) => contrast(c, g) < target); i++) c = grounds.reduce((acc, g) => ensureContrast(acc, g, target, ink), c);
  return c;
}

export const css = (c: Rgb) => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
export const cssA = (c: Rgb, a: number) => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a})`;

/** The built-in surfaces, tokens.css --bg-0..2 of each theme (palette.test.ts checks they match), for an accent-only
 * palette's contrast math. */
export const BUILTIN_GROUNDS: { dark: Rgb[]; light: Rgb[] } = {
  dark: [
    [22, 24, 29],
    [29, 32, 39],
    [37, 41, 50],
  ],
  light: [
    [243, 244, 247],
    [255, 255, 255],
    [236, 238, 242],
  ],
}; // theme-exempt: the built-in surfaces (tokens.css --bg-0..2), checked against it in palette.test.ts

/**
 * The accent tokens for one accent on the given surfaces (each accent-as-text use reaches 4.6:1 on all of them): every
 * token tokens.css derives from the built-in green, the marks beside green words included (senior review S2), so a
 * desktop accent never leaves a second accent on screen. Status colors keep their meaning and aren't touched.
 */
export function accentVars(accent: Rgb, grounds: Rgb[], isDark: boolean): Record<string, string> {
  const ink = isDark ? WHITE : BLACK;
  const onAccent = wantsLightInk(accent) ? WHITE : BLACK;
  const accentInk = css(legibleOnAll(accent, grounds, 4.6, ink));
  const none = cssA(BLACK, 0);
  // light: the accent as a mark beside the words (a disc, a dot, a link's underline band) with a dark edge; dark: the
  // words themselves carry it, the ✓ in the accent's ink
  const edge = css(mix(accent, BLACK, 0.85));
  return {
    "--accent": css(accent),
    "--accent-text": css(onAccent),
    "--accent-ink": accentInk,
    "--accent-soft": cssA(accent, isDark ? 0.18 : 0.14),
    "--focus-ring": css(accent),
    "--mark-fill": isDark ? none : css(accent),
    "--mark-ink": isDark ? accentInk : css(onAccent),
    "--mark-edge": isDark ? none : edge,
    "--link-mark": isDark ? none : css(accent),
  };
}

/**
 * CSS custom properties for the Desktop theme. Status colors (ok/warn/error)
 * are deliberately not touched: they carry meaning.
 */
export function paletteToCssVars(p: DesktopPalette): Record<string, string> {
  const vars: Record<string, string> = {};
  let grounds: Rgb[];
  if (p.source === "kde" && p.window && p.windowText) {
    const page = p.view ?? p.window;
    const pageText = p.viewText ?? p.windowText;
    const panel = p.window;
    const button = p.button ?? panel;
    const inset = mix(panel, page, 0.5);
    grounds = [page, panel, inset, button];
    Object.assign(vars, {
      "--bg-0": css(mix(page, p.isDark ? BLACK : WHITE, 0.15)),
      "--bg-1": css(panel),
      "--bg-2": css(button),
      "--bg-3": css(mix(button, pageText, 0.1)),
      "--border-1": css(mix(panel, pageText, p.isDark ? 0.14 : 0.16)),
      "--border-2": css(mix(panel, pageText, 0.24)),
      "--text-1": css(legibleOnAll(pageText, grounds, 7, p.isDark ? WHITE : BLACK)),
      "--text-2": css(legibleOnAll(p.windowText, grounds, 5.5, p.isDark ? WHITE : BLACK)),
      "--text-3": css(legibleOnAll(p.inactiveText ?? mix(pageText, page, 0.4), grounds, 4.5, p.isDark ? WHITE : BLACK)),
      "--progress-track": css(mix(button, pageText, 0.12)),
    });
  } else grounds = p.isDark ? BUILTIN_GROUNDS.dark : BUILTIN_GROUNDS.light;
  Object.assign(vars, accentVars(p.accent, grounds, p.isDark));
  return vars;
}

/** The accent in use: the Desktop theme takes the desktop's (whatever the accent setting says), when it has colors. */
export function accentText(a: { theme: string; accent: string }, desktopColors: boolean): string {
  if (a.theme !== "desktop" && a.accent !== "desktop") return "built-in accent";
  return desktopColors ? "desktop accent" : "built-in accent (no desktop colors found)";
}
