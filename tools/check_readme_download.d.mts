// Types for tools/check_readme_download.mjs (its unit test imports it).
export const APP: string;
export function checkDownload(readme: string, version: string): string[];
export function fixDownload(readme: string, version: string): string;
export function checkAll(app?: string): string[];
