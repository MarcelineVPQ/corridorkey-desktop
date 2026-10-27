// Frame sequences, the way a TD reads a folder (lsseq): numbered files with the same name around the number, the
// same padding and extension are one sequence, `sh010_plate.####.exr  1001-1100`, its gaps listed. dir groups them
// and Tab offers one pattern per sequence, in the CLI's own `####` syntax (docs/CLI.md "Inputs"). Pure.

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

/** Numbered files grouped into sequences (two or more frames); everything else stays a single file, in order. */
export function groupSequences(names: readonly string[]): { sequences: Sequence[]; singles: string[] } {
  const groups = new Map<string, { prefix: string; pad: number; ext: string; frames: { n: number; name: string }[] }>();
  // loop: NOT-WORTH — one pass over a folder's names (≤ the readdir), per dir / Tab
  for (const name of names) {
    const m = NUMBERED.exec(name);
    const ext = m?.[3] ?? "";
    if (!m || VIDEO.has(ext.toLowerCase())) continue;
    const key = `${m[1]}\0${m[2].length}\0${ext}`;
    const g = groups.get(key) ?? { prefix: m[1], pad: m[2].length, ext, frames: [] };
    g.frames.push({ n: Number(m[2]), name });
    groups.set(key, g);
  }
  const grouped = new Set<string>();
  const sequences: Sequence[] = [];
  // loop: NOT-WORTH — one pass over the groups, per dir / Tab
  for (const g of groups.values()) {
    if (g.frames.length < 2) continue;
    // loop: NOT-WORTH — sorts one sequence's frames
    g.frames.sort((a, b) => a.n - b.n);
    // loop: NOT-WORTH — as above
    const nums = g.frames.map((f) => f.n);
    const r = runs(nums);
    // loop: NOT-WORTH — the sequence's runs: the gap after each but the last
    const gaps = r.slice(1).map(([start], i): [number, number] => [r[i][1] + 1, start - 1]);
    // loop: NOT-WORTH — at most GAPS_SHOWN gaps
    const shown = gaps.slice(0, GAPS_SHOWN).map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`));
    const missing = gaps.length ? shown.join(", ") + (gaps.length > GAPS_SHOWN ? ` and ${gaps.length - GAPS_SHOWN} more` : "") : null;
    // loop: NOT-WORTH — the sequence's names
    for (const f of g.frames) grouped.add(f.name);
    sequences.push({
      pattern: `${g.prefix}${"#".repeat(g.pad)}${g.ext}`,
      range: `${nums[0]}-${nums[nums.length - 1]}`,
      count: nums.length,
      missing,
      // loop: NOT-WORTH — as above
      names: g.frames.map((f) => f.name),
    });
  }
  // loop: NOT-WORTH — one pass over the names
  return { sequences, singles: names.filter((n) => !grouped.has(n)) };
}
