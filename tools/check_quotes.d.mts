// Types for tools/check_quotes.mjs (its unit test imports it).
export const APP: string;
export const SKIP: Map<string, string>;
export function notSpeech(phrase: string): boolean;
export function quotesIn(lines: string[], i: number): string[];
export function checkFiles(files: { name: string; text: string }[]): string[];
export function trackedFiles(app?: string): { name: string; text: string }[];
export function checkAll(app?: string): string[];
