// Types for tools/check_providers.mjs (its unit test imports it).
export const APP: string;
export function enumNames(rs: string, enumName: string): string[];
export function comboNames(rs: string): string[];
export function screenNames(formatTs: string): Record<string, string>;
export function checkFormat(formatTs: string, providers: string[]): string[];
export function checkProtocol(doc: string, providers: string[]): string[];
export function checkDeviceLists(file: string, text: string, devices: string[]): string[];
export function checkBugForm(yml: string, names: Record<string, string>, providers: string[]): string[];
export function checkAll(app?: string): string[];
