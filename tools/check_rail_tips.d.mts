// Types for tools/check_rail_tips.mjs (its unit test imports it).
export const APP: string;
export const TIP_SUMMARIES: Map<string, string>;
export function railItems(ts: string): { id: string; tip: string }[];
export function sectionTitles(tsx: string): string[];
export function missingFromTip(tip: string, titles: string[]): string[];
export function checkAll(app?: string): string[];
