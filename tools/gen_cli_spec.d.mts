// Types for tools/gen_cli_spec.mjs (its unit test imports it).
export const SPEC_FILE: string;
export function findCliBins(env?: NodeJS.ProcessEnv): string[];
export function hostSpec(env?: NodeJS.ProcessEnv): { bin: string; spec: Record<string, unknown> } | null;
export function readSpec(bin: string): Record<string, unknown>;
export function specText(spec: unknown): string;
