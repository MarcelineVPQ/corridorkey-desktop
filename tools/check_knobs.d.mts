// Types for tools/check_knobs.mjs (its unit test imports it).
export const APP: string;
export function knobs(text: string, quoted?: boolean): string[];
export function checkKnobs(engine: string[], app: string[], doc: string): string[];
export function checkAll(app?: string): string[];
