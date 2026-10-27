// Types for tools/check_platform_docs.mjs (its unit test imports it).
export const APP: string;
export const EXCEPTIONS: Map<string, string>;
export function packagedSystems(yml: string): string[];
export function uninstallProblems(system: string, un: string): string[];
export function checkSystems(systems: string[], wiki: Record<string, string>, exceptions?: Map<string, string>): string[];
export function checkAll(app?: string): string[];
