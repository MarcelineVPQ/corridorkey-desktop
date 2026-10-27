// The Console's two files in userData (docs/CONSOLE.md):
//   console-audit.jsonl    append-only: every elevation (granted, refused, dropped), every elevated command (its
//                          argv, the resolved targets, its exit) and every write folder allowed or removed. Only ever opened to append (flag "a"); never
//                          rewritten, truncated or pruned by the app.
//   console-history.jsonl  the lines typed, per user, across restarts, each with a stable number, its folder and
//                          time ({n, time, line, cwd}), and its end once known ({n, exit, state}): the newest
//                          HISTORY_CAP, consecutive duplicates kept once, a line typed with a leading space not at all;
//                          compacted (temp file + rename, one row per line) when it grows past the cap by a tenth.
// Every read and write is async; writes go one at a time, in order.
import { appendFile, open, readFile, rename, writeFile } from "node:fs/promises";
import type { ConsoleHistoryEntry } from "../../../src/shared/types";

export const HISTORY_CAP = 5000;
/** How much of the audit log's end `history --audit` reads (the file itself is never cut). */
const AUDIT_TAIL_BYTES = 256 * 1024;

export interface AuditEntry {
  time: string;
  /** allowed / removed: a folder added to (after its confirmation) or taken from the Console's write folders */
  event: "granted" | "refused" | "dropped" | "run" | "exit" | "allowed" | "removed";
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

  /** Resolves true once the entry is written, false when it couldn't be (an elevated command then doesn't run). */
  append(e: Omit<AuditEntry, "time">, now = new Date()): Promise<boolean> {
    const line = JSON.stringify({ time: now.toISOString(), ...e }) + "\n";
    // loop: NOT-WORTH — one async append per elevation event [bounded: a local file write]
    return this.serial
      .then(() => appendFile(this.file, line, { flag: "a" }))
      .then(
        () => true,
        (err: Error) => {
          // error: SHOWN — the caller refuses the elevated command; logged here too
          console.error("[console] audit log:", err.message);
          return false;
        },
      );
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
  private items: ConsoleHistoryEntry[] = [];
  private nextN = 1;
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
        const rows = parseLines<Partial<ConsoleHistoryEntry> & { line?: unknown }>(t);
        this.inFile = rows.length;
        const all: ConsoleHistoryEntry[] = [];
        const byN = new Map<number, ConsoleHistoryEntry>();
        let n = 0;
        // loop: NOT-WORTH — the file's lines, once at start
        for (const r of rows) {
          // an end row ({n, exit, state}) completes its line; an older file's lines have no number: counted on
          if (typeof r.line !== "string") {
            const e = typeof r.n === "number" ? byN.get(r.n) : undefined;
            if (e) Object.assign(e, { exit: typeof r.exit === "number" ? r.exit : null, state: typeof r.state === "string" ? r.state : null });
            continue;
          }
          n = typeof r.n === "number" && r.n > n ? r.n : n + 1;
          const e: ConsoleHistoryEntry = {
            n,
            line: r.line,
            time: typeof r.time === "string" ? r.time : null,
            cwd: typeof r.cwd === "string" ? r.cwd : null,
            exit: typeof r.exit === "number" ? r.exit : null,
            state: typeof r.state === "string" ? r.state : null,
          };
          all.push(e);
          byN.set(n, e);
        }
        this.nextN = n + 1;
        // lines typed before the file was read come after it
        // loop: NOT-WORTH — the few lines typed while it loads
        for (const e of this.items) e.n = this.nextN++;
        this.items = [...all.slice(-this.cap), ...this.items];
      },
      // error: NOT-WORTH — no history yet (first start)
      () => {},
    );
  }

  /**
   * A typed line, kept with its folder and time; resolves with its number (stable: it never changes), or null when it
   * isn't kept: an empty line, or one typed with a leading space (bash's ignorespace). The same as the last: its number.
   */
  async add(line: string, cwd: string | null = null, now = new Date()): Promise<number | null> {
    await this.loaded;
    if (!line.trim() || line.startsWith(" ")) return null;
    const last = this.items[this.items.length - 1];
    if (last?.line === line) return last.n;
    const e: ConsoleHistoryEntry = { n: this.nextN++, line, time: now.toISOString(), cwd, exit: null, state: null };
    this.items.push(e);
    if (this.items.length > this.cap) this.items.splice(0, this.items.length - this.cap);
    await this.write({ n: e.n, time: e.time, line, cwd });
    return e.n;
  }

  /** Line `n` has ended: its exit code and state (done, failed, refused, cancelled), kept with it. */
  async ended(n: number, exit: number | null, state: string): Promise<void> {
    await this.loaded;
    let e: ConsoleHistoryEntry | undefined;
    // loop: NOT-WORTH — ≤ HISTORY_CAP entries, newest first; the line just run is the last or close to it
    for (let i = this.items.length - 1; i >= 0 && !e; i--) if (this.items[i].n === n) e = this.items[i];
    if (!e) return;
    Object.assign(e, { exit, state });
    await this.write({ n, exit, state });
  }

  private async write(row: object): Promise<void> {
    try {
      if (this.inFile + 1 > this.cap + Math.ceil(this.cap / 10)) {
        // loop: NOT-WORTH — the history rewritten once per cap/10 rows [bounded: a local file write]
        const all = this.items.map((e) => JSON.stringify(e) + "\n").join("");
        await this.serial.then(async () => {
          // loop: NOT-WORTH — as above
          await writeFile(`${this.file}.tmp`, all);
          // loop: NOT-WORTH — as above
          await rename(`${this.file}.tmp`, this.file);
        });
        this.inFile = this.items.length;
      } else {
        // loop: NOT-WORTH — one async append per typed line or its end [bounded: a local file write]
        await this.serial.then(() => appendFile(this.file, JSON.stringify(row) + "\n", { flag: "a" }));
        this.inFile++;
      }
    } catch (e) {
      // error: SHOWN — logged; the line stays in this session's history
      console.error("[console] history:", (e as Error).message);
    }
  }

  /** Entries whose line (or folder) contains `query` (any case), newest first, at most `limit`. */
  entries(query: string, limit = 200): ConsoleHistoryEntry[] {
    const q = query.toLowerCase();
    const out: ConsoleHistoryEntry[] = [];
    // loop: NOT-WORTH — ≤ HISTORY_CAP lines, newest first, stops at the limit; per search
    for (let i = this.items.length - 1; i >= 0 && out.length < limit; i--) {
      const e = this.items[i];
      if (e.line.toLowerCase().includes(q) || (e.cwd ?? "").toLowerCase().includes(q)) out.push({ ...e });
    }
    return out;
  }

  /** Lines containing `query` (any case), newest first, at most `limit` (Ctrl+R, the suggestions). */
  search(query: string, limit = 200): string[] {
    const q = query.toLowerCase();
    const out: string[] = [];
    // loop: NOT-WORTH — ≤ HISTORY_CAP lines, newest first, stops at the limit; per Ctrl+R keystroke
    for (let i = this.items.length - 1; i >= 0 && out.length < limit; i--) if (this.items[i].line.toLowerCase().includes(q)) out.push(this.items[i].line);
    return out;
  }

  /** The newest `n` lines, oldest first. */
  recent(n: number): string[] {
    // loop: NOT-WORTH — ≤ n entries
    return this.items.slice(-n).map((e) => e.line);
  }

  /** The newest `n` entries, oldest first. */
  last(n: number): ConsoleHistoryEntry[] {
    // loop: NOT-WORTH — ≤ n entries
    return this.items.slice(-n).map((e) => ({ ...e }));
  }
}
