// Frame sequences, the way a TD reads a folder (lsseq): numbered files with the same name around the number, the
// same padding and extension are one sequence, `sh010_plate.####.exr  1001-1100`, its gaps listed. dir groups them
// and Tab offers one pattern per sequence, in the CLI's own `####` syntax (docs/CLI.md "Inputs"). A typed pattern
// (`####`, `%04d`, `$F4`, `@@@@`) names one sequence for every built-in that takes a path (sequenceOf). Pure.

export interface Sequence {
  /** the CLI's pattern: sh010_plate.####.exr */
  pattern: string;
  /** first-last: 1001-1100 */
  range: string;
  count: number;
  /** the frames missing between the first and last ("1047, 1050-1052"), or null */
  missing: string | null;
  /** the member files' names, by frame */
  names: string[];
}

/** Videos are clips, never frames of a pattern (media.ts VIDEO_EXT). */
const VIDEO = new Set([".mp4", ".mov", ".mkv", ".avi", ".mxf", ".webm", ".m4v"]);
/** The last run of digits, before an optional extension. */
const NUMBERED = /^(.*?)(\d+)(\.[A-Za-z][A-Za-z0-9]*)?$/;
/** Gaps listed before "and N more". */
const GAPS_SHOWN = 8;

/** 1001-1003, 1005, 1007-1008 (sorted, unique frames in). */
export function frameRanges(frames: readonly number[]): string {
  // loop: NOT-WORTH — one sequence's runs, per listing row
  return runs(frames)
    .map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`))
    .join(", ");
}

function runs(frames: readonly number[]): [number, number][] {
  const out: [number, number][] = [];
  // loop: NOT-WORTH — one pass over a sequence's frames
  for (const f of frames) {
    const last = out[out.length - 1];
    if (last && f === last[1] + 1) last[1] = f;
    else out.push([f, f]);
  }
  return out;
}

/**
 * The frame token in a file name, as ck-cli frames.rs find_token reads it: `####` (one digit per #), `%04d` / `%d`,
 * Houdini's `$F4` / `$F`, and `@@@@` (one digit per @, RV's and OIIO's). Where it starts, its length, its padding.
 */
export function frameToken(name: string): { at: number; len: number; pad: number } | null {
  // loop: NOT-WORTH — one short file name
  for (let i = 0; i < name.length; i++) {
    const c = name[i];
    if (c === "#" || c === "@") {
      let n = 1;
      // loop: NOT-WORTH — the run of # or @
      while (name[i + n] === c) n++;
      return { at: i, len: n, pad: n };
    }
    if (c === "%") {
      const m = /^%(\d*)d/.exec(name.slice(i));
      if (m) return { at: i, len: m[0].length, pad: Math.max(1, Number(m[1] || "1")) };
    }
    if (c === "$" && name[i + 1] === "F") return /[1-9]/.test(name[i + 2] ?? "") ? { at: i, len: 3, pad: Number(name[i + 2]) } : { at: i, len: 2, pad: 1 };
  }
  return null;
}

/** One sequence from its frames (sorted by number): range, count, gaps; `pattern` in the CLI's `####` form. */
function makeSequence(prefix: string, pad: number, ext: string, frames: { n: number; name: string }[]): Sequence {
  // loop: NOT-WORTH — as below
  const nums = frames.map((f) => f.n);
  const r = runs(nums);
  // loop: NOT-WORTH — the sequence's runs: the gap after each but the last
  const gaps = r.slice(1).map(([start], i): [number, number] => [r[i][1] + 1, start - 1]);
  // loop: NOT-WORTH — at most GAPS_SHOWN gaps
  const shown = gaps.slice(0, GAPS_SHOWN).map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`));
  const missing = gaps.length ? shown.join(", ") + (gaps.length > GAPS_SHOWN ? ` and ${gaps.length - GAPS_SHOWN} more` : "") : null;
  return {
    pattern: `${prefix}${"#".repeat(pad)}${ext}`,
    range: `${nums[0]}-${nums[nums.length - 1]}`,
    count: nums.length,
    missing,
    // loop: NOT-WORTH — the sequence's names
    names: frames.map((f) => f.name),
  };
}

/**
 * The sequence a typed pattern names among a folder's file names (`plate.####.exr`, `plate.%04d.exr`,
 * `plate.$F4.exr`, `plate.@@@@.exr` alike), its frames as the CLI reads them (frames.rs frame_of: the pattern's
 * padding, or wider for a larger number). Null: `pattern` has no frame token, or no file is one of its frames.
 */
export function sequenceOf(pattern: string, names: readonly string[]): Sequence | null {
  const t = frameToken(pattern);
  if (!t) return null;
  const prefix = pattern.slice(0, t.at);
  const suffix = pattern.slice(t.at + t.len);
  const frames: { n: number; name: string }[] = [];
  // loop: NOT-WORTH — one pass over a folder's names, per built-in given a pattern
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(suffix) || name.length <= prefix.length + suffix.length) continue;
    const digits = name.slice(prefix.length, name.length - suffix.length);
    if (/^\d+$/.test(digits) && (digits.length === t.pad || (digits.length > t.pad && !digits.startsWith("0")))) frames.push({ n: Number(digits), name });
  }
  if (!frames.length) return null;
  // loop: NOT-WORTH — sorts one sequence's frames
  frames.sort((a, b) => a.n - b.n);
  return makeSequence(prefix, t.pad, suffix, frames);
}

/**
 * Numbered files grouped into sequences (two or more frames); everything else stays a single file, in order. Grouped as
 * lsseq groups and as the CLI reads a pattern (frames.rs frame_of: the pattern's padding, or wider for a number that
 * needs it): with the same name around the number and extension, an unpadded run (`f.9`, `f.10`, `f.120`) and a run
 * that only outgrows its padding (`sim.9999`, `sim.10000`) are one sequence; numbers with leading zeros and a
 * different width (`a.0001`, `a.01`) are not (SME review 2026-10-27 M2).
 */
export function groupSequences(names: readonly string[]): { sequences: Sequence[]; singles: string[] } {
  const groups = new Map<string, { prefix: string; ext: string; frames: { n: number; name: string; digits: string }[] }>();
  // loop: NOT-WORTH — one pass over a folder's names (≤ the readdir), per dir / Tab
  for (const name of names) {
    const m = NUMBERED.exec(name);
    const ext = m?.[3] ?? "";
    if (!m || VIDEO.has(ext.toLowerCase())) continue;
    const key = `${m[1]}\0${ext}`;
    const g = groups.get(key) ?? { prefix: m[1], ext, frames: [] };
    g.frames.push({ n: Number(m[2]), name, digits: m[2] });
    groups.set(key, g);
  }
  const grouped = new Set<string>();
  const sequences: Sequence[] = [];
  // loop: NOT-WORTH — one pass over the groups, per dir / Tab
  for (const g of groups.values()) {
    // by width, then number: each width joins the run before it unless a name of that width has a leading zero (its
    // own padding); the run's narrowest width is its pattern's padding
    // loop: NOT-WORTH — sorts one group's frames
    g.frames.sort((a, b) => a.digits.length - b.digits.length || a.n - b.n);
    const chains: { pad: number; width: number; frames: typeof g.frames }[] = [];
    // loop: NOT-WORTH — one pass over the group's frames
    for (const f of g.frames) {
      const last = chains[chains.length - 1];
      const width = f.digits.length;
      if (last && (width === last.width || !widthPadded(g.frames, width))) {
        last.frames.push(f);
        last.width = width;
      } else chains.push({ pad: width, width, frames: [f] });
    }
    // loop: NOT-WORTH — the group's few runs
    for (const c of chains) {
      if (c.frames.length < 2) continue;
      // loop: NOT-WORTH — sorts one sequence's frames
      c.frames.sort((a, b) => a.n - b.n);
      // loop: NOT-WORTH — the sequence's names
      for (const f of c.frames) grouped.add(f.name);
      sequences.push(makeSequence(g.prefix, c.pad, g.ext, c.frames));
    }
  }
  // loop: NOT-WORTH — one pass over the names
  return { sequences, singles: names.filter((n) => !grouped.has(n)) };
}

/** Whether a name of this width has a leading zero (then that width is a padding of its own, not an overflow). */
// loop: NOT-WORTH — one group's frames, once per width
const widthPadded = (frames: readonly { digits: string }[], width: number) => frames.some((f) => f.digits.length === width && f.digits.startsWith("0"));

/** The image files corridorkey reads from a frame folder (ck-core clip.rs frame_paths: .exr .png .jpg .jpeg, any case, not hidden). */
export const isFrameFile = (name: string): boolean => !name.startsWith(".") && /.\.(exr|png|jpe?g)$/i.test(name);

/**
 * A frame folder's first and last frame numbers as corridorkey numbers them (ck-core FrameNumbers::for_source): one
 * sequence's own numbers, all of its frames; files with no number at all count from 1001. A folder holding several
 * sequences (or a sequence and other frames) is an error that says which: the CLI would key them all as one clip
 * (SME review 2026-10-27 M2). `names`: the folder's frame files (isFrameFile).
 */
export function folderRange(names: readonly string[]): { range: [number, number]; pad: number } | { error: string } {
  if (!names.length) return { error: "no frames (.exr, .png, .jpg) in it" };
  const { sequences, singles } = groupSequences(names);
  if (sequences.length === 1 && !singles.length) {
    const [a, b] = sequences[0].range.split("-").map(Number);
    // loop: NOT-WORTH — the pattern's # run
    return { range: [a, b], pad: sequences[0].pattern.split("").filter((c) => c === "#").length };
  }
  if (!sequences.length && names.length === 1) {
    const m = NUMBERED.exec(names[0]);
    return m ? { range: [Number(m[2]), Number(m[2])], pad: m[2].length } : { range: [1001, 1001], pad: 4 };
  }
  // loop: NOT-WORTH — the folder's frame names
  if (!sequences.length && names.every((n) => !NUMBERED.test(n))) return { range: [1001, 1000 + names.length], pad: 4 };
  // loop: NOT-WORTH — the few sequences named
  const what = [...sequences.map((s) => `${s.pattern} ${s.range}`), ...singles.slice(0, 3)];
  const more = sequences.length + singles.length - what.length;
  return {
    error: `it holds several sequences or other frames (${what.join(", ")}${more > 0 ? ` and ${more} more` : ""}), and corridorkey keys a whole folder as one clip: put each sequence in a folder of its own`,
  };
}
