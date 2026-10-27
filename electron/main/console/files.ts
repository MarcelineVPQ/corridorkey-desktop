// The Console's read-only file built-ins' pure parts (Phase 4 step 7): text from bytes (a binary file is refused, a
// cut first or last line dropped), wc's counts across chunks, du's sizes, tree's drawing. Reading is runner.ts's
// (ConsoleFs.readRange: never more than TEXT_MAX of a file at once).

/** The most of a file cat, head and tail read (from its start or its end). */
export const TEXT_MAX = 1024 * 1024;
/** The most lines they print (a block keeps 2000). */
export const LINES_MAX = 2000;
/** wc reads at most this much of a file, TEXT_MAX at a time. */
export const WC_MAX = 256 * 1024 * 1024;

/** A file is text unless its first 8 KiB have a NUL (git's and grep's rule). */
export function isBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8192).includes(0);
}

/**
 * The lines in `buf` (UTF-8): a final new line ends the last line (no empty one after it); `cutStart` (a read that
 * didn't start at the file's start) drops the first, partial line; `cutEnd` (one that didn't reach the end) the last.
 */
export function textLines(buf: Buffer, cutStart = false, cutEnd = false): string[] {
  const lines = buf.toString("utf8").split(/\r?\n/);
  if (lines[lines.length - 1] === "" && !cutEnd) lines.pop();
  if (cutStart) lines.shift();
  if (cutEnd) lines.pop();
  return lines;
}

/** wc's counts over a file's chunks, in order: new lines, words (runs of non-space), bytes. */
export class TextCount {
  lines = 0;
  words = 0;
  bytes = 0;
  private inWord = false;
  add(buf: Buffer): void {
    this.bytes += buf.length;
    // loop: HOT-PATH-OK — one pass over a chunk's bytes (≤ TEXT_MAX), per chunk; wc reads at most WC_MAX
    for (const c of buf) {
      if (c === 10) this.lines++;
      const space = c === 32 || (c >= 9 && c <= 13);
      if (!space && !this.inWord) this.words++;
      this.inWord = !space;
    }
  }
}

export interface TreeNode {
  name: string;
  folder: boolean;
  /** a sequence's frames ("1001-1100 · 100 frames"), shown after its pattern */
  note?: string;
  children?: TreeNode[];
  /** entries in it not shown (past the depth: null; past the cap: their count) */
  more?: number;
}

/** A tree as lines: ├── └── │, folders with a separator, a folder past the depth or the cap says what it holds. */
export function treeLines(root: TreeNode, sep: string): string[] {
  const out = [root.name];
  const walk = (n: TreeNode, lead: string) => {
    const kids = n.children ?? [];
    // loop: NOT-WORTH — one folder's shown entries, per tree (capped by the caller)
    for (const [i, k] of kids.entries()) {
      const last = i === kids.length - 1 && !n.more;
      out.push(`${lead}${last ? "└── " : "├── "}${k.name}${k.folder ? sep : ""}${k.note ? `  ${k.note}` : ""}`);
      if (k.children) walk(k, lead + (last ? "    " : "│   "));
    }
    if (n.more) out.push(`${lead}└── … ${n.more} more`);
  };
  walk(root, "");
  return out;
}
