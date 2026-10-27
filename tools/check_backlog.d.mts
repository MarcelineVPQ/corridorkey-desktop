// Types for tools/check_backlog.mjs (its unit test imports it).
export interface BranchRow {
  row: string;
  branch: string;
  open: boolean;
  at: string;
}
export const APP: string;
export const STATUSES: string[];
export function cells(line: string): string[];
export function checkTable(md: string): { problems: string[]; branches: BranchRow[] };
export function checkBranches(branches: BranchRow[], isMerged: (branch: string) => boolean): string[];
export function checkAll(app?: string): string[];
