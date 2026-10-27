// Types for tools/check_guide.mjs (its unit test imports it).
export const APP: string;
export function sectionTitles(tsx: string): string[];
export function inGuide(guide: string, title: string): boolean;
export function checkAll(app?: string): string[];
