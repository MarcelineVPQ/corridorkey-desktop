// Types for tools/check_wiki.mjs (its unit test imports it).
export interface CliSpecIn {
  commands: { name: string; hidden?: boolean; args: { long: string | null; short: string | null; positional?: boolean; hidden?: boolean; possible_values?: string[] }[] }[];
}
export const APP: string;
export const WIKI: string;
export function readPages(dir?: string): Record<string, string>;
export function splitFences(text: string): { code: string[]; prose: string };
export function cliCommands(spec: CliSpecIn): { name: string; flags: { long: string; short: string | null }[] }[];
export function progressFormats(spec: CliSpecIn): string[];
export function exitCodes(exitRs: string): number[];
export function builtinNames(registryTs: string): string[];
export function engineMessages(files: { path: string; text: string }[]): string[];
export function rustFiles(root: string): { path: string; text: string }[];
export function slug(heading: string): string;
export function anchors(text: string): Set<string>;
export function checkCommandLine(page: string | undefined, spec: CliSpecIn, exits: number[]): string[];
export function checkConsole(page: string | undefined, builtins: string[]): string[];
export function checkTroubleshooting(page: string | undefined, messages: string[]): string[];
export function checkLinks(pages: Record<string, string>, repoFile: (path: string) => string | null): string[];
export function checkAll(app?: string): string[];
export function diffPublished(src: string, published: string): string[];
