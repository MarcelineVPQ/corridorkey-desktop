// `j <part…>` (zoxide / autojump): the folders the history's lines were typed in, ranked by frecency (how often and
// how recently), the best one whose path matches every part, in order, the last part in its last folder's name. Pure.

export interface Visit {
  cwd: string | null;
  /** ISO time the line was typed (null: an old line without one, counted as old) */
  time: string | null;
}

export interface Ranked {
  folder: string;
  score: number;
}

const HOUR = 3600_000;

/** zoxide's weights: a visit within the hour counts 4, the day 2, the week 1/2, older 1/4. */
function weight(time: string | null, now: number): number {
  const t = time ? Date.parse(time) : NaN;
  const age = Number.isNaN(t) ? Infinity : now - t;
  return age < HOUR ? 4 : age < 24 * HOUR ? 2 : age < 7 * 24 * HOUR ? 0.5 : 0.25;
}

/** Every folder in the visits with its score, best first (ties: the path, for a stable order). */
export function rankFolders(visits: readonly Visit[], now: number): Ranked[] {
  const score = new Map<string, number>();
  // loop: NOT-WORTH — the history's lines (≤ its cap), once per j
  for (const v of visits) if (v.cwd) score.set(v.cwd, (score.get(v.cwd) ?? 0) + weight(v.time, now));
  // loop: NOT-WORTH — sorts the distinct folders, once per j
  return [...score].map(([folder, s]) => ({ folder, score: s })).sort((a, b) => b.score - a.score || a.folder.localeCompare(b.folder));
}

/**
 * Whether `folder` matches the parts (any case): each part in the path, in order, the last one in the last folder's
 * name (zoxide's rule: `j sh010` goes to …/sh010, not to …/sh010/plates).
 */
export function matches(folder: string, parts: readonly string[]): boolean {
  const f = folder.toLowerCase();
  // loop: NOT-WORTH — one path's folders, per folder ranked
  const last = f.split(/[\\/]/).filter(Boolean).pop() ?? "";
  let at = 0;
  // loop: NOT-WORTH — the few parts typed, per folder ranked
  for (const p of parts) {
    const i = f.indexOf(p.toLowerCase(), at);
    if (i < 0) return false;
    at = i + p.length;
  }
  return parts.length === 0 || last.includes(parts[parts.length - 1].toLowerCase());
}
