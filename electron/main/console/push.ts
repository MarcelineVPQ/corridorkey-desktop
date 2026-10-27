// The Console's block updates to the page, like the state push (index.ts scheduleSend): coalesced to at most one send
// every PUSH_EVERY_MS, only while the window is shown; a hidden window gets each changed block's latest state the moment
// it shows.
import type { ConsoleBlock } from "../../../src/shared/types";

export const PUSH_EVERY_MS = 100;

export class BlockPusher {
  private readonly pending = new Map<number, ConsoleBlock>();
  // per running block: how many of its lines (dropped ones included) the page has; a push sends only the ones after
  private readonly sentLines = new Map<number, number>();
  private timer: NodeJS.Timeout | null = null;
  private shown = false;

  constructor(private readonly send: (blocks: ConsoleBlock[]) => void) {}

  /** A block changed: it goes out with the next push. */
  mark(b: ConsoleBlock): void {
    this.pending.set(b.id, b);
    this.schedule();
  }

  setShown(v: boolean): void {
    this.shown = v;
    this.schedule();
  }

  /**
   * `b` with only the lines the page doesn't have yet (senior review 2026-10-26 N6: a push resent the whole block,
   * up to 2000 lines of 4000 characters, ten times a second). A block no longer running is forgotten; were it pushed
   * again it would carry all its lines, which mergeBlocks places by number, so nothing is doubled.
   */
  private appended(b: ConsoleBlock): ConsoleBlock {
    const total = b.linesDropped + b.lines.length;
    const from = Math.max(this.sentLines.get(b.id) ?? 0, b.linesDropped);
    if (b.state === "running") this.sentLines.set(b.id, total);
    else this.sentLines.delete(b.id);
    return { ...b, lines: b.lines.slice(from - b.linesDropped), linesFrom: from };
  }

  private schedule(): void {
    if (!this.shown || this.timer || !this.pending.size) return;
    // lifetime: OK — one-shot coalescing timer, re-armed only by the next change
    // loop: HOT-PATH-OK — block pushes coalesced to ≤ 10/s, only while the window is shown and a command prints
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.shown) return;
      // loop: HOT-PATH-OK — the few blocks changed since the last push, ≤ 10/s
      const blocks = [...this.pending.values()].map((b) => this.appended(b));
      this.pending.clear();
      this.send(blocks);
    }, PUSH_EVERY_MS);
  }
}
