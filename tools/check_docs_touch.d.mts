// Types for tools/check_docs_touch.mjs (its unit test imports it).
export interface Commit {
  sha: string;
  message: string;
  files: string[];
}
export const APP: string;
export const CLI_SOURCES: string[];
export const CLI_DOCS: string[];
export const EXCEPTIONS: Map<string, string>;
export function parseLog(text: string): Commit[];
export function checkCommits(commits: Commit[], exceptions?: Map<string, string>): string[];
export function checkAll(app?: string, range?: string): string[];
export function checkStaged(msgFile: string, app?: string, amend?: boolean): string[];
