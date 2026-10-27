// The Console's two files in userData (docs/CONSOLE.md):
//   console-audit.jsonl    append-only: every elevation (granted, refused, dropped) and every elevated command (its
//                          argv, the resolved targets, its exit). Only ever opened to append (flag "a"); never
//                          rewritten, truncated or pruned by the app.
//   console-history.jsonl  the lines typed, per user, across restarts: the newest HISTORY_CAP, consecutive
//                          duplicates kept once; compacted (temp file + rename) when it grows past the cap by a tenth.
// Every read and write is async; writes go one at a time, in order.
import { appendFile, open, readFile, rename, writeFile } from "node:fs/promises";

export const HISTORY_CAP = 5000;
/** How much of the audit log's end `history --audit` reads (the file itself is never cut). */
const AUDIT_TAIL_BYTES = 256 * 1024;

export interface AuditEntry {
  time: string;
  event: "granted" | "refused" | "dropped" | "run" | "exit";
  argv?: string[];
  targets?: string[];
  exit?: number | null;
  reason?: string;
}

/** One write after another (an append never overtakes a compaction). */
class Serial {
  private last: Promise<unknown> = Promise.resolve();
  then<T>(f: () => Promise<T>): Promise<T> {
    const p = this.last.then(f, f);
    // error: NOT-WORTH — a failed write is logged by its caller; the chain goes on
    this.last = p.catch(() => {});
    return p;
  }
}

export class AuditLog {
  private readonly serial = new Serial();
  constructor(private readonly file: string) {}

  append(e: Omit<AuditEntry, "time">, now = new Date()): Promise<void> {
    const line = JSON.stringify({ time: now.toISOString(), ...e }) + "\n";
    // loop: NOT-WORTH — one async append per elevation event [bounded: a local file write]
    return this.serial.then(() => appendFile(this.file, line, { flag: "a" })).catch((err: Error) => console.error("[console] audit log:", err.message));
  }

  /** The newest `n` entries (from the file's last AUDIT_TAIL_BYTES). */
  async tail(n: number): Promise<AuditEntry[]> {
    let text = "";
    try {
      // loop: NOT-WORTH — one open + read of the log's end, per `history --audit`
      const fh = await open(this.file, "r");
      try {
        const size = (await fh.stat()).size;
        const len = Math.min(size, AUDIT_TAIL_BYTES);
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, size - len);
        text = buf.toString("utf8");
        // a cut first line (the read started mid-line) is dropped
        if (len < size) text = text.slice(text.indexOf("\n") + 1);
      } finally {
        await fh.close();
      }
    } catch {
      // error: NOT-WORTH — no log yet: nothing elevated so far
      return [];
    }
    return parseLines<AuditEntry>(text).slice(-n);
  }
}

function parseLines<T>(text: string): T[] {
  const out: T[] = [];
  // loop: NOT-WORTH — the lines of one small file, once per read
  for (const l of text.split("\n")) {
    if (!l.trim()) continue;
    try {
      out.push(JSON.parse(l) as T);
    } catch {
      // error: NOT-WORTH — a line cut by a crash mid-write is skipped
    }
  }
  return out;
}

export class History {
  private lines: string[] = [];
  private inFile = 0;
  private readonly serial = new Serial();
  readonly loaded: Promise<void>;

  constructor(
    private readonly file: string,
    private readonly cap = HISTORY_CAP,
  ) {
    // loop: NOT-WORTH — one async read of the history at start
    this.loaded = readFile(file, "utf8").then(
      (t) => {
        // loop: NOT-WORTH — the file's lines, once at start
        const all = parseLines<{ line?: unknown }>(t)
          .map((e) => e.line)
          .filter((l): l is string => typeof l === "string");
        this.inFile = all.length;
        this.lines = [...all.slice(-this.cap), ...this.lines];
      },
      // error: NOT-WORTH — no history yet (first start)
      () => {},
    );
  }

  /** A typed line, kept (an empty one, or the same as the last, isn't). */
  async add(line: string, now = new Date()): Promise<void> {
    await this.loaded;
    if (!line.trim() || this.lines[this.lines.length - 1] === line) return;
    this.lines.push(line);
    if (this.lines.length > this.cap) this.lines.splice(0, this.lines.length - this.cap);
    const text = JSON.stringify({ time: now.toISOString(), line }) + "\n";
    try {
      if (this.inFile + 1 > this.cap + Math.ceil(this.cap / 10)) {
        // loop: NOT-WORTH — the history rewritten once per cap/10 lines typed [bounded: a local file write]
        const all = this.lines.map((l) => JSON.stringify({ line: l }) + "\n").join("");
        await this.serial.then(async () => {
          // loop: NOT-WORTH — as above
          await writeFile(`${this.file}.tmp`, all);
          // loop: NOT-WORTH — as above
          await rename(`${this.file}.tmp`, this.file);
        });
        this.inFile = this.lines.length;
      } else {
        // loop: NOT-WORTH — one async append per typed line [bounded: a local file write]
        await this.serial.then(() => appendFile(this.file, text, { flag: "a" }));
        this.inFile++;
      }
    } catch (e) {
      // error: SHOWN — logged; the line stays in this session's history
      console.error("[console] history:", (e as Error).message);
    }
  }

  /** Lines containing `query` (any case), newest first, at most `limit`. */
  search(query: string, limit = 200): string[] {
    const q = query.toLowerCase();
    const out: string[] = [];
    // loop: NOT-WORTH — ≤ HISTORY_CAP lines, newest first, stops at the limit; per Ctrl+R keystroke
    for (let i = this.lines.length - 1; i >= 0 && out.length < limit; i--) if (this.lines[i].toLowerCase().includes(q)) out.push(this.lines[i]);
    return out;
  }

  /** The newest `n` lines, oldest first. */
  recent(n: number): string[] {
    return this.lines.slice(-n);
  }
}
