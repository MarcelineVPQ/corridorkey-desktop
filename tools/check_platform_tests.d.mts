// Types for tools/check_platform_tests.mjs (its unit test imports it).
export const APP: string;
export function codeOnly(src: string): string;
export function branchesOn(code: string): string[];
export const EXCEPTIONS: Map<string, string>;
export function checkModule(module: string, code: string, tests: { path: string; code: string }[], exceptions?: Map<string, string>): string[];
export function checkAll(app?: string): string[];
