// TensorRT facts the app shows: which engine range a clip's size falls in (the engine's own rule, mirrored here and
// checked against engine-rs/crates/ck-core/src/tensorrt.rs and clip.rs by tests/unit/trt.test.ts), the networks a
// range builds, and what is (and isn't yet) measured for the model set the app ships. Nothing here is estimated: a
// number either comes from a measurement of that model set or isn't shown.

// tensorrt.rs DIM_RANGES / MAX_SIDE / MAX_AREA, clip.rs SHAPE_QUANTUM
export const TRT_DIM_RANGES: readonly (readonly [number, number])[] = [
  [128, 512],
  [640, 896],
  [1024, 1280],
  [1408, 1664],
  [1792, 2176],
  [2304, 2816],
  [2944, 3456],
  [3584, 4096],
];
export const TRT_MAX_SIDE = 4096;
export const TRT_MAX_AREA = 2176 * 4096;
export const SHAPE_QUANTUM = 128;

// the five networks, in the order the engine builds them (runtime.rs PIECES), and their names on screen
export const TRT_PIECES = ["cradio", "moge", "rvm", "stage1", "stage2"] as const;
export const PIECE_NAMES: Record<string, string> = { cradio: "C-RADIO", moge: "MoGe", rvm: "RVM", stage1: "stage 1", stage2: "stage 2" };

// the engine's `fallback_reason` for a job whose range isn't built yet (pipeline/mod.rs TRT_NOT_BUILT)
export const TRT_NOT_BUILT = "TensorRT for this resolution range isn't built yet";

// README, Speed, "TensorRT on onnx.4" (2026-10-25): the one-time build at 4K, seconds per network (RTX 5080, model
// set onnx.4). Used only to weight the background build's progress bar by network (buildFraction); never shown as a time.
export const MEASURED_4K_BUILD_S: Record<string, number> = { cradio: 31.3, moge: 27.4, rvm: 24.7, stage1: 145.1, stage2: 59.3 };

// The same measurement, in words: one run each on an RTX 5080, model set onnx.4; other cards and sizes weren't measured.
export const TRT_SPEED = "Measured on an RTX 5080: a clip takes 0.63× CUDA's time at 1280×1080 and 0.76× at 4K, with about 1.5-2 GB more graphics memory.";
export const TRT_BUILD_COST = "about 4.4-4.8 minutes and 2.8 GB once (measured at 1280×1080 and 4K on an RTX 5080)";
export const TRT_BUILD_TEXT = `The one-time build per resolution range: ${TRT_BUILD_COST}.`;

// loop: NOT-WORTH — eight ranges, per lookup
const rangeOf = (v: number) => TRT_DIM_RANGES.find(([lo, hi]) => v >= lo && v <= hi) ?? null;

/**
 * The size part of the engine range a clip of `width` x `height` falls in ("h1792-2176_w3584-4096"), at full
 * internal resolution; null outside every range (it runs on CUDA). tensorrt.rs bucket_for, without the window.
 */
export function trtSizeKey(width: number, height: number): string | null {
  const sh = Math.ceil(height / SHAPE_QUANTUM) * SHAPE_QUANTUM;
  const sw = Math.ceil(width / SHAPE_QUANTUM) * SHAPE_QUANTUM;
  if (sh > TRT_MAX_SIDE || sw > TRT_MAX_SIDE) return null;
  const h = rangeOf(sh);
  const w = rangeOf(sw);
  if (!h || !w || h[1] * w[1] > TRT_MAX_AREA) return null;
  return `h${h[0]}-${h[1]}_w${w[0]}-${w[1]}`;
}

/** The built ranges a size falls in, by their stage-1 window ("h…_w…_t1-8_f1-4" → 8). */
export function builtWindows(sizeKey: string, built: readonly string[]): number[] {
  return (
    built
      // loop: NOT-WORTH — a few built ranges, per render of one clip's settings
      .filter((k) => k.startsWith(`${sizeKey}_t`))
      // loop: NOT-WORTH — as above
      .map((k) => Number(/_t1-(\d+)_/.exec(k)?.[1] ?? NaN))
      // loop: NOT-WORTH — as above
      .filter((n) => Number.isFinite(n))
  );
}

/** A range key in words: "h1792-2176_w3584-4096_t1-8_f1-4" → "up to 4096×2176, windows up to 8 frames". */
export function rangeText(key: string): string {
  const m = /^h(\d+)-(\d+)_w(\d+)-(\d+)_t1-(\d+)/.exec(key);
  return m ? `up to ${m[4]}×${m[2]}, windows up to ${m[5]} frames` : key;
}

/** The background build's current step: "4K: building stage 1 (network 4 of 5)", null when nothing builds. */
export function prebuildStep(ranges: readonly { label: string; state: string; piece: string | null }[]): string | null {
  // loop: NOT-WORTH — two ranges
  const r = ranges.find((x) => x.state === "building");
  if (!r) return null;
  if (!r.piece) return `${r.label}: starting (checking what is built)`;
  const i = TRT_PIECES.indexOf(r.piece as (typeof TRT_PIECES)[number]);
  return `${r.label}: building ${PIECE_NAMES[r.piece] ?? r.piece} (network ${i + 1} of ${TRT_PIECES.length})`;
}

/**
 * How far a range's build is when the engine builds `piece` (it builds in TRT_PIECES order and skips what is built):
 * the networks before it, weighted by their measured 4K build times when `measured`, else one share each.
 */
export function buildFraction(piece: string | null, measured: boolean): number {
  const i = piece ? TRT_PIECES.indexOf(piece as (typeof TRT_PIECES)[number]) : -1;
  if (i <= 0) return 0;
  const weight = (p: string) => (measured ? MEASURED_4K_BUILD_S[p] : 1);
  // loop: NOT-WORTH — five networks
  const total = TRT_PIECES.reduce((s, p) => s + weight(p), 0);
  // loop: NOT-WORTH — as above
  return TRT_PIECES.slice(0, i).reduce((s, p) => s + weight(p), 0) / total;
}

// Which sizes TensorRT builds for (backlog row 56). A size the app builds ahead: what it sends to the engine's
// `trt_build`, and its name on screen.
export interface TrtSize {
  label: string;
  width: number;
  height: number;
}

/** What the app builds before anyone has chosen: 4K first (the minutes a 4K job would wait), then HD. */
export const DEFAULT_TRT_SIZES: readonly TrtSize[] = [
  { label: "4K DCI", width: 4096, height: 2160 },
  { label: "HD", width: 1920, height: 1080 },
];

/**
 * Common production sizes, named, in Engine settings' list. Sizes that pad into the same engine range share a row,
 * built for the first of them (the background build's own size where it has one). The last two are past TensorRT's
 * ranges: they always run on CUDA, and the list says so.
 */
export const TRT_NAMED_SIZES: readonly TrtSize[] = [
  { label: "720p", width: 1280, height: 720 },
  { label: "HD", width: 1920, height: 1080 },
  { label: "2K DCI", width: 2048, height: 1080 },
  { label: "2K full aperture", width: 2048, height: 1556 },
  { label: "2.8K", width: 2880, height: 1620 },
  { label: "4K DCI", width: 4096, height: 2160 },
  { label: "UHD", width: 3840, height: 2160 },
  { label: "4K open gate", width: 4096, height: 3072 },
  { label: "6K", width: 6144, height: 3240 },
];

/** A size as people write it: "HD 1920×1080". */
export const sizeText = (s: TrtSize) => `${s.label} ${s.width}×${s.height}`;

/** The size part of a range key ("h1024-1280_w1792-2176_t1-48_f1-4" → "h1024-1280_w1792-2176"), null if not one. */
export const sizeKeyOf = (rangeKey: string) => /^h\d+-\d+_w\d+-\d+/.exec(rangeKey)?.[0] ?? null;

/** The largest frame a size range takes ("h1024-1280_w1792-2176" → "up to 2176×1280"). */
export function sizeRangeText(sizeKey: string): string {
  const m = /^h(\d+)-(\d+)_w(\d+)-(\d+)/.exec(sizeKey);
  return m ? `up to ${m[4]}×${m[2]}` : sizeKey;
}

/** One row of the size list: a size range, the named and chosen sizes in it, and the size it is built for. */
export interface TrtSizeRow {
  key: string;
  sizes: TrtSize[];
  build: TrtSize;
}

/**
 * The size list's rows: the named sizes grouped by range, then each chosen size outside them, then any range built
 * on this card that none of them names (an earlier version's). `outside`: the named sizes TensorRT can't take.
 * A chosen size is built at its own size (a row's named size could get another window).
 */
export function trtSizeRows(chosen: readonly TrtSize[], built: readonly string[]): { rows: TrtSizeRow[]; outside: TrtSize[] } {
  const rows: TrtSizeRow[] = [];
  const outside: TrtSize[] = [];
  // loop: NOT-WORTH — nine named sizes and the few chosen ones, per render of the TensorRT section
  for (const s of [...TRT_NAMED_SIZES, ...chosen]) {
    const key = trtSizeKey(s.width, s.height);
    if (!key) {
      outside.push(s);
      continue;
    }
    // loop: NOT-WORTH — a dozen rows
    const row = rows.find((r) => r.key === key);
    if (!row) rows.push({ key, sizes: [s], build: s });
    // loop: NOT-WORTH — a few sizes per row
    else if (!row.sizes.some((x) => x.width === s.width && x.height === s.height)) row.sizes.push(s);
  }
  // loop: NOT-WORTH — the few chosen sizes
  for (const c of chosen) {
    // loop: NOT-WORTH — a dozen rows
    const row = rows.find((r) => r.key === trtSizeKey(c.width, c.height));
    if (row) row.build = c;
  }
  // loop: NOT-WORTH — a few built ranges
  for (const k of built) {
    const key = sizeKeyOf(k);
    // loop: NOT-WORTH — a dozen rows
    if (!key || rows.some((r) => r.key === key)) continue;
    const m = /^h(\d+)-(\d+)_w(\d+)-(\d+)/.exec(key)!;
    const s = { label: "Built earlier", width: Number(m[4]), height: Number(m[2]) };
    rows.push({ key, sizes: [s], build: s });
  }
  return { rows, outside };
}

/** A chosen size from the page or settings.json, checked: a name of at most 80 characters and whole sides from 16 to 16384 px. */
export function sanitizeTrtSize(v: unknown): TrtSize | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const side = (n: unknown) => (typeof n === "number" && Number.isInteger(n) && n >= 16 && n <= 16384 ? n : null);
  const width = side(o.width);
  const height = side(o.height);
  if (typeof o.label !== "string" || !o.label.trim() || width === null || height === null) return null;
  return { label: o.label.trim().slice(0, 80), width, height };
}

/**
 * A size typed into Engine settings' "A size of my own" and its range: null unless the main process takes it
 * (sanitizeTrtSize: whole sides from 16 px) and it falls in a TensorRT range, so the Build button is only enabled when
 * pressing it does something.
 */
export function ownTrtSize(width: number, height: number): { size: TrtSize; key: string } | null {
  const size = sanitizeTrtSize({ label: "Your size", width, height });
  const key = size && trtSizeKey(size.width, size.height);
  return size && key ? { size, key } : null;
}

/** The chosen sizes from settings.json: each checked, one per range (the first kept), at most 32; absent = the defaults. */
export function sanitizeTrtSizes(v: unknown): TrtSize[] {
  // loop: NOT-WORTH — two sizes, once at start
  if (!Array.isArray(v)) return DEFAULT_TRT_SIZES.map((s) => ({ ...s }));
  const out: TrtSize[] = [];
  // loop: NOT-WORTH — at most 32 sizes, once at start
  for (const x of v.slice(0, 32)) {
    const s = sanitizeTrtSize(x);
    const key = s && trtSizeKey(s.width, s.height);
    // loop: NOT-WORTH — as above
    if (s && key && !out.some((o) => trtSizeKey(o.width, o.height) === key)) out.push(s);
  }
  return out;
}
