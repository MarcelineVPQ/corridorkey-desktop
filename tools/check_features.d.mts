// Types for tools/check_features.mjs (its unit test imports it).
export interface FeatureSet {
  target: string;
  features: string[];
}
export const APP: string;
export const LINT_EXCEPTIONS: Map<string, string>;
export function shippedSets(sh: string): FeatureSet[];
export function lintSets(sh: string): FeatureSet[];
export function checkFeatures(shipped: FeatureSet[], linted: FeatureSet[], noticesFeatures: string[], aboutTargets: string[], exceptions?: Map<string, string>): string[];
export function checkAll(app?: string): string[];
