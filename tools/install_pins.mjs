// What electron/main/install.ts pins for the first-run downloads, read from its source (no build needed): the model
// sets and the wheels. One reader for tools/gen_notices.mjs and tools/check_notices_downloads.mjs, so the notices
// and their gate can't disagree on what is downloaded.

/**
 * The model sets by their constant, in the file's order: every `const X_SET = "…"`, and `${OTHER_SET}-suffix` built
 * from one before. Map: constant name -> set.
 */
export function modelSetConsts(src) {
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
  return sets;
}

/** The model sets, in the file's order. */
export const modelSets = (src) => [...modelSetConsts(src).values()];

// the catalog's parts in the file's order: Linux, Windows, macOS, the AMD runtime (behind the CK_AMD switch) and its
// per-card device wheels, then the opt-in TensorRT download
const AMD = "Linux, AMD cards (CK_AMD switch)";
const PARTS = [
  ["Linux", /export const RUNTIME = \{([\s\S]*?)\n\};/],
  ["Windows", /export const RUNTIME_WIN = \{([\s\S]*?)\n\};/],
  ["macOS", /export const RUNTIME_MAC = \{([\s\S]*?)\n\};/],
  [AMD, /export const RUNTIME_AMD = \{([\s\S]*?)\n\};/],
  [AMD, /export const ROCM_DEVICE: Record<string, Download> = \{([\s\S]*?)\n\};/],
  ["Linux, opt-in TensorRT", /export const TENSORRT = \{\s*libs: \{([\s\S]*?)\} as Download/],
];

/** The wheels, each once: { name, version, platforms } (name as in the file name: underscores). */
export function wheels(src) {
  const out = new Map();
  // loop: NOT-WORTH — four catalog parts
  for (const [platform, re] of PARTS) {
    const body = src.match(re)?.[1];
    if (!body) throw new Error(`install.ts's ${platform} download list was not found`);
    // ROCm's device wheels are pinned through rocmDevice("gfx…", size, sha256): the file name comes from its template
    const device = src.match(/file: `(rocm_sdk_device)_\$\{gfx\}-([0-9][0-9A-Za-z.+]*)-[^`]+\.whl`/);
    const pins = [
      // loop: NOT-WORTH — a part's wheels (≤ 9)
      ...[...body.matchAll(/file: "(([A-Za-z0-9_]+)-([0-9][0-9A-Za-z.+]*)-[^"]+\.whl)"/g)].map((m) => [m[2], m[3]]),
      // loop: NOT-WORTH — the dozen device wheels
      ...[...body.matchAll(/rocmDevice\("(\w+)"/g)].map((m) => {
        if (!device) throw new Error("install.ts's rocmDevice file name was not found");
        return [`${device[1]}_${m[1]}`, device[2]];
      }),
    ];
    // loop: NOT-WORTH — as above
    for (const [name, version] of pins) {
      const key = `${name} ${version}`;
      const w = out.get(key) ?? { name, version, platforms: [] };
      if (!w.platforms.includes(platform)) w.platforms.push(platform);
      out.set(key, w);
    }
  }
  return [...out.values()];
}
