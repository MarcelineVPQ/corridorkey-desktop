// Types for tools/check_model_sets.mjs (its unit test imports it).
export interface Pin {
  file: string;
  size: number;
  sha256: string;
}
export interface PinnedSet {
  set: string;
  base: string | null;
  files: Pin[];
}
export interface Asset {
  name: string;
  size: number;
  digest?: string | null;
}
export const APP: string;
export function pinnedSets(installTs: string): PinnedSet[];
export function checkRelease(s: PinnedSet, assets: Asset[], baseAssets: Asset[] | null): string[];
export function checkAll(app?: string): Promise<string[]>;
