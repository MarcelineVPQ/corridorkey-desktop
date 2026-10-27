// Types for tools/check_cli_parity.mjs (its unit test imports it).
import type { CliSpecIn } from "./check_wiki.mjs";
export interface Manifest {
  fields?: Record<string, { flags?: string[]; "not-on-cli"?: string }>;
  "cli-only"?: Record<string, string>;
}
export const APP: string;
export function engineFields(jobRs: string): string[];
export function jobCommandFlags(spec: CliSpecIn): Set<string>;
export function cliTable(argsRs: string): [flag: string, field: string][];
export function appFields(queueTs: string): string[];
export function writerFlags(jobCommandTs: string): Set<string>;
export function checkParity(input: { manifest: Manifest; engine: string[]; spec: CliSpecIn; table: [string, string][]; app: string[]; writer: Set<string>; farmTs: string }): string[];
export function checkAll(app?: string): string[];
