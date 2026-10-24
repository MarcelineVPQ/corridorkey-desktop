// Types for tools/list_loops.mjs (its unit test imports it).
export interface Row {
  file: string;
  line: number;
  kind: string;
  verdict: string;
  reason: string;
  flags: string[];
  /** 1-based line of the comment the verdict came from, 0 without one. */
  verdictLine: number;
  /** False for an exempt row (a plain Rust `for` loop or iterator chain): listed, never fails the gate. */
  required: boolean;
  head: string;
}
export const VERDICTS: string[];
export const ROOTS: string[];
export function langOf(file: string): "ts" | "rs" | "py" | "cpp" | "sh" | null;
export function requiresVerdict(r: Pick<Row, "kind" | "flags" | "head">, lang: string): boolean;
export function scan(text: string, file: string): Row[];
export function listFiles(root?: string): string[];
export function listAll(root?: string): Row[];
export function problems(rows: Row[]): string[];
export function markdown(rows: Row[]): string;
