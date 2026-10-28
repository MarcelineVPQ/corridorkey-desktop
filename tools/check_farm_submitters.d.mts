// Types for tools/check_farm_submitters.mjs (its unit test imports it).
export interface CliFlags {
  flags: Set<string>;
  shorts: Set<string>;
  formats: string[];
  commands?: Map<string, Set<string>>;
}
export const APP: string;
export function cliFlags(spec: { commands: { name?: string; hidden?: boolean; args: { long: string | null; short?: string | null; possible_values?: string[] }[] }[] }): CliFlags;
export function checkCommands(path: string, text: string, commands: Map<string, Set<string>> | undefined): string[];
export function checkFile(path: string, text: string, cli: CliFlags): string[];
export function checkAll(app?: string): string[];
