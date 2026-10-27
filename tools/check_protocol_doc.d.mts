// Types for tools/check_protocol_doc.mjs (its unit test imports it).
export interface Source {
  path: string;
  text: string;
}
export const APP: string;
export const PONG_NOT_READ: Map<string, string>;
export function replyObjects(src: string): { type: string; keys: string[]; at: number }[];
export function assignedKeys(rs: string): string[];
export function withoutTests(rs: string): string;
export function checkDoc(doc: string, sources: Source[], errorCodes: string[]): string[];
export function checkApp(appFiles: Source[], doc: string, engineCmds: string[], replyTypes: string[], pongKeys: string[], notRead?: Map<string, string>): string[];
export function checkAll(app?: string): string[];
