// Types for tools/check_texts.mjs (its unit test imports it).
export interface SharedText {
  name: string;
  text: string;
}
export const APP: string;
export function sharedTexts(ts: string): SharedText[];
export function codeOnly(src: string): string;
export function checkFile(path: string, src: string, texts: SharedText[]): string[];
export function checkAll(app?: string): string[];
