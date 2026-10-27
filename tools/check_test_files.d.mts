// Types for tools/check_test_files.mjs (its unit test imports it).
export const APP: string;
export const UNTESTED: Map<string, string>;
export function importsOf(path: string, src: string): string[];
export function checkModules(modules: Record<string, string>, tests: Record<string, string>, untested?: Map<string, string>): string[];
export function checkAll(app?: string): string[];
