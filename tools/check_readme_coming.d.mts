// Types for tools/check_readme_coming.mjs (its unit test imports it).
export const APP: string;
export function statuses(backlog: string): Map<string, string>;
export function checkComing(readme: string, status: Map<string, string>): string[];
export function checkAll(app?: string): string[];
