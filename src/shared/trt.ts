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

// README, Speed, 0.0.7-dev: the one-time builds at 4K, seconds per network (RTX 5080, cold timing cache), measured
// on model set onnx.3. Used only to weight the background build's progress bar by network (buildFraction); never
// shown as a time.
export const MEASURED_4K_BUILD_S: Record<string, number> = { cradio: 36.8, moge: 33.1, rvm: 35.6, stage1: 139.2, stage2: 57.8 };

// The app ships model set 2.0.0-onnx.4 (2026-10-25); TensorRT's speed and build time were measured only on onnx.3
// (README, Speed, 0.0.6-dev and 0.0.7-dev), so the app says so instead of showing onnx.3's numbers (UI pass 2026-10-25).
export const TRT_NOT_MEASURED = "Speed on this model set: not measured yet.";
export const TRT_BUILD_NOT_MEASURED = "Build time on this model set: not measured yet.";

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
