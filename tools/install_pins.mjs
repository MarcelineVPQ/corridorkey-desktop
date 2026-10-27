// What electron/main/install.ts pins for the first-run downloads, read from its source (no build needed): the model
// sets and the wheels. One reader for tools/gen_notices.mjs and tools/check_notices_downloads.mjs, so the notices
// and their gate can't disagree on what is downloaded.

/** The model sets, in the file's order: every `const X_SET = "…"`, and `${OTHER_SET}-suffix` built from one before. */
export function modelSets(src) {
  const sets = new Map();
  // loop: NOT-WORTH — the file's few set constants
  for (const [, name, literal, base, suffix] of src.matchAll(/const (\w+_SET) = (?:"([^"]+)"|`\$\{(\w+_SET)\}([^`$]*)`);/g)) {
    if (literal === undefined && !sets.has(base)) throw new Error(`install.ts: ${name} is built from ${base}, which isn't pinned before it`);
    sets.set(name, literal ?? sets.get(base) + suffix);
  }
  if (!sets.size) throw new Error("install.ts no longer pins a model set (const …_SET)");
  // every download from a model release names one of those constants, so no set is pinned past this reader
  // loop: NOT-WORTH — the file's few inRelease calls
  for (const [, arg] of src.matchAll(/\binRelease\(([^)]*)\)/g)) if (!sets.has(arg)) throw new Error(`install.ts: inRelease(${arg}) is not one of the pinned sets (const …_SET = "…")`);
  return [...sets.values()];
}

// the catalog's parts in the file's order: Linux, Windows, macOS, then the opt-in TensorRT download
const PARTS = [
  ["Linux", /export const RUNTIME = \{([\s\S]*?)\n\};/],
  ["Windows", /export const RUNTIME_WIN = \{([\s\S]*?)\n\};/],
  ["macOS", /export const RUNTIME_MAC = \{([\s\S]*?)\n\};/],
  ["Linux, opt-in TensorRT", /export const TENSORRT = \{\s*libs: \{([\s\S]*?)\} as Download/],
];

/** The wheels, each once: { name, version, platforms } (name as in the file name: underscores). */
export function wheels(src) {
  const out = new Map();
  // loop: NOT-WORTH — four catalog parts
  for (const [platform, re] of PARTS) {
    const body = src.match(re)?.[1];
    if (!body) throw new Error(`install.ts's ${platform} download list was not found`);
    // loop: NOT-WORTH — a part's wheels (≤ 9)
    for (const [, , name, version] of body.matchAll(/file: "(([A-Za-z0-9_]+)-([0-9][0-9A-Za-z.]*)-[^"]+\.whl)"/g)) {
      const key = `${name} ${version}`;
      const w = out.get(key) ?? { name, version, platforms: [] };
      w.platforms.push(platform);
      out.set(key, w);
    }
  }
  return [...out.values()];
}
