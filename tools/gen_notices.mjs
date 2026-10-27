#!/usr/bin/env node
// Rebuilds THIRD_PARTY_NOTICES.md (LICENSE §6) from the sources of truth, never by hand:
//   the engine's Rust crates: cargo-about over engine-rs/Cargo.lock, the whole workspace (the engine and the
//     `corridorkey` command line ship together; engine-rs/about.toml: the three release targets, the release features
//     of tools/build_engine.sh, build and dev crates left out);
//   the app's npm packages: package-lock.json's production packages (what electron-builder puts in app.asar) and the
//     licence file each one ships in node_modules;
//   the first-run downloads: the wheels and model sets electron/main/install.ts pins;
//   OpenColorIO and the C++ libraries its bundled build links into the engine: OCIO_LIBS below (versions from the
//     vendored sources, texts in licenses/ocio/).
// Licences of the parts that are not code here (downloads, foundation models, build tools) are the table below, each
// from its publisher's own statement; a download it doesn't know is written "licence not determined".
//
//   node tools/gen_notices.mjs          write THIRD_PARTY_NOTICES.md
//   node tools/gen_notices.mjs --check  exit 1 if the file is not what the sources give (tools/release.sh)
//
// Needs cargo-about (`cargo install --locked --features cli cargo-about`): on PATH, or CARGO_ABOUT=<path to it>.
// The output is deterministic: every list is sorted, nothing depends on time or the machine.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(APP, "THIRD_PARTY_NOTICES.md");
const ENGINE_FEATURES = "ort-dynamic,cuda,tensorrt,ocio";
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const byNameVersion = (a, b) => cmp(a.name, b.name) || cmp(a.version, b.version);

// --- the Rust crates (cargo-about) ---
function rustCrates() {
  const bin = process.env.CARGO_ABOUT || "cargo-about";
  let raw;
  try {
    // cargo metadata needs every crate of the lock on disk (all targets'); a no-op once they are. cargo-about then
    // runs offline, so the licence texts come from the crates themselves, never from the network
    // loop: NOT-WORTH — one fetch of the locked crates [bounded: 300 s]
    execFileSync("cargo", ["fetch", "--locked", "--quiet"], { cwd: join(APP, "engine-rs"), stdio: ["ignore", "ignore", "pipe"], timeout: 300_000 });
    // loop: NOT-WORTH — one cargo-about run (cargo metadata, offline, from the lock) [bounded: 120 s]
    raw = execFileSync(
      bin,
      [
        "generate",
        "--format",
        "json",
        "--locked",
        "--offline",
        "--no-default-features",
        "--features",
        ENGINE_FEATURES.replace(/,/g, " "),
        "-c",
        "engine-rs/about.toml",
        "-m",
        "engine-rs/Cargo.toml",
        "--workspace",
      ],
      { cwd: APP, encoding: "utf8", maxBuffer: 64 << 20, timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (e) {
    const why = e.code === "ENOENT" ? `${bin} is not installed (cargo install --locked --features cli cargo-about, or CARGO_ABOUT=<path>)` : String(e.stderr || e.message).trim();
    throw new Error(`gen_notices: cargo-about failed: ${why}`);
  }
  const j = JSON.parse(raw);
  // loop: NOT-WORTH — the engine's crates (~60), once per run
  const crates = j.crates.map((c) => ({ name: c.package.name, version: c.package.version, license: c.license })).sort(byNameVersion);
  // loop: NOT-WORTH — the distinct licence texts (~40), once per run
  const texts = j.licenses.map((l) => ({
    id: l.id,
    text: l.text,
    // loop: NOT-WORTH — the crates that share one text
    users: l.used_by.map((u) => ({ name: u.crate.name, version: u.crate.version })).sort(byNameVersion),
  }));
  return { crates, texts: groupTexts(texts) };
}

// --- the npm packages that ship (package-lock.json, not dev) ---
function npmPackages() {
  const lock = JSON.parse(readFileSync(join(APP, "package-lock.json"), "utf8"));
  const out = [];
  // loop: NOT-WORTH — the lock's packages (~350), once per run
  for (const [path, p] of Object.entries(lock.packages)) {
    if (!path || p.dev) continue;
    const name = path.replace(/^.*node_modules\//, "");
    const dir = join(APP, path);
    if (!existsSync(dir)) throw new Error(`gen_notices: ${path} is in the lock but not installed (npm ci first)`);
    // loop: NOT-WORTH — one package folder's names
    const files = readdirSync(dir)
      .filter((f) => /^(licen[cs]e|copying)(\.(md|txt))?$/i.test(f))
      .sort();
    const text = files.length ? readFileSync(join(dir, files[0]), "utf8") : null;
    out.push({ name, version: p.version, license: p.license || "licence not determined", text });
  }
  // loop: NOT-WORTH — sorts ~110 packages, once per run
  out.sort(byNameVersion);
  // loop: NOT-WORTH — ~110 packages, once per run
  const withText = out.filter((p) => p.text !== null);
  // loop: NOT-WORTH — ~110 packages, once per run
  const texts = groupTexts(withText.map((p) => ({ id: p.license, text: p.text, users: [{ name: p.name, version: p.version }] })));
  return { packages: out, texts };
}

/** One entry per distinct text (whitespace-normalised), its users merged and sorted; the entries sorted too. */
function groupTexts(list) {
  const map = new Map();
  // loop: NOT-WORTH — ~150 texts, once per run
  for (const t of list) {
    const text = t.text
      .replace(/\r\n?/g, "\n")
      .replace(/[ \t]+$/gm, "")
      .trim();
    const key = `${t.id}\n${text}`;
    const g = map.get(key) ?? { id: t.id, text, users: [] };
    g.users.push(...t.users);
    map.set(key, g);
  }
  // loop: NOT-WORTH — the groups, once per run
  for (const g of map.values()) g.users.sort(byNameVersion);
  // loop: NOT-WORTH — sorts the groups (~50), once per run
  return [...map.values()].sort((a, b) => cmp(a.id, b.id) || cmp(a.users[0].name, b.users[0].name) || cmp(a.text, b.text));
}

// --- the first-run downloads (electron/main/install.ts) ---
// Each wheel's licence, from its PyPI metadata and the licence it carries; links are the publishers' own pages.
const CUDA_EULA = "NVIDIA proprietary licence (PyPI: LicenseRef-NVIDIA-Proprietary), the [CUDA Toolkit EULA](https://docs.nvidia.com/cuda/eula/index.html)";
const WHEEL_LICENCES = [
  [/^onnxruntime(_gpu)?$/, "MIT (Microsoft); the wheel's LICENSE and ThirdPartyNotices.txt are kept with the libraries"],
  [/^nvidia_cudnn_cu\d+$/, "NVIDIA proprietary licence, the [cuDNN Software License Agreement](https://docs.nvidia.com/deeplearning/cudnn/latest/reference/eula.html)"],
  [/^nvidia_(cublas|cuda_nvrtc|cuda_runtime|cufft|curand|nvjitlink)$/, CUDA_EULA],
  [/^tensorrt_cu\d+_libs$/, "NVIDIA proprietary licence (the wheel's LICENSE.txt), the [TensorRT Software License Agreement](https://docs.nvidia.com/deeplearning/tensorrt/latest/reference/sla.html)"],
  [
    /^msvc_runtime$/,
    "Microsoft proprietary licence (PyPI: Proprietary): Microsoft's redistributable Visual C++ runtime, [its licence terms](https://visualstudio.microsoft.com/license-terms/vs2022-cruntime/)",
  ],
];
function downloads() {
  const src = readFileSync(join(APP, "electron/main/install.ts"), "utf8");
  const repo = readFileSync(join(APP, "electron/main/updateFeed.ts"), "utf8").match(/export const REPO = "([^"]+)"/)?.[1];
  const set = src.match(/const MODEL_SET = "([^"]+)"/)?.[1];
  const trtSet = src.match(/const TRT_MODEL_SET = "([^"]+)"/)?.[1];
  if (!repo || !set || !trtSet) throw new Error("gen_notices: install.ts / updateFeed.ts no longer name the repository or the model sets");
  // the catalog's parts in the file's order: Linux, Windows, macOS, then the opt-in TensorRT download
  const parts = [
    ["Linux", /export const RUNTIME = \{([\s\S]*?)\n\};/],
    ["Windows", /export const RUNTIME_WIN = \{([\s\S]*?)\n\};/],
    ["macOS", /export const RUNTIME_MAC = \{([\s\S]*?)\n\};/],
    ["Linux, opt-in TensorRT", /export const TENSORRT = \{\s*libs: \{([\s\S]*?)\} as Download/],
  ];
  const wheels = new Map();
  // loop: NOT-WORTH — four catalog parts, once per run
  for (const [platform, re] of parts) {
    const body = src.match(re)?.[1];
    if (!body) throw new Error(`gen_notices: install.ts's ${platform} download list was not found`);
    // loop: NOT-WORTH — a part's wheels (≤ 9)
    for (const m of body.matchAll(/file: "(([A-Za-z0-9_]+)-([0-9][0-9A-Za-z.]*)-[^"]+\.whl)"/g)) {
      const [, , name, version] = m;
      const key = `${name} ${version}`;
      const w = wheels.get(key) ?? { name, version, platforms: [] };
      w.platforms.push(platform);
      wheels.set(key, w);
    }
  }
  // loop: NOT-WORTH — ~15 wheels, once per run
  const rows = [...wheels.values()].sort(byNameVersion).map((w) => {
    // loop: NOT-WORTH — five licence rules per wheel
    const lic = WHEEL_LICENCES.find(([re]) => re.test(w.name))?.[1] ?? "licence not determined";
    const host = w.name.startsWith("tensorrt_") ? "pypi.nvidia.com" : "pypi.org";
    const project = w.name.replace(/_/g, "-");
    const page = host === "pypi.org" ? `https://pypi.org/project/${project}/${w.version}/` : `https://pypi.nvidia.com/${project}/`;
    return `| ${project} | ${w.version} | ${w.platforms.join(", ")} | ${lic} | [${host}](${page}) |`;
  });
  return { repo, set, trtSet, rows };
}

// --- OpenColorIO and the C++ libraries its bundled build links into the engine (ocio-sys 0.3.0, engine-rs/vendor) ---
// Versions: OpenColorIO's CMakeLists.txt project() and each library's own source as vendored in
// engine-rs/vendor/ocio-sys/vendor/OpenColorIO/ext (expat.h, yaml-cpp's and Imath's CMakeLists.txt, zlib.h, mz.h,
// xxhash.h; pystring has no version in its source: OCIO's pin, Installpystring.cmake's recommended 1.1.4, and the
// vendored pystring.cpp / .h are byte-identical to pystring's v1.1.4 tag). Each licence text is the library's own
// file at that tag (licenses/ocio/); SampleICC's is its section of OpenColorIO 2.5.2's THIRD-PARTY.md.
const OCIO_LIBS = [
  ["OpenColorIO", "2.5.2", "Contributors to the OpenColorIO Project", "BSD-3-Clause", "https://github.com/AcademySoftwareFoundation/OpenColorIO/tree/v2.5.2", "OpenColorIO-2.5.2.txt"],
  [
    "SampleICC (stripped, inside OpenColorIO)",
    "1.2.6",
    "The International Color Consortium",
    "ICC Software License 0.2",
    "https://sourceforge.net/p/sampleicc/code/HEAD/tree/tags/1.2.6/",
    "SampleICC-1.2.6.txt",
  ],
  ["xxHash (inside OpenColorIO)", "0.8.1", "Yann Collet", "BSD-2-Clause", "https://github.com/Cyan4973/xxHash/tree/v0.8.1", "xxHash-0.8.1.txt"],
  ["expat", "2.7.2", "Thai Open Source Software Center Ltd, Clark Cooper, Expat maintainers", "MIT", "https://github.com/libexpat/libexpat/tree/R_2_7_2", "expat-2.7.2.txt"],
  ["yaml-cpp", "0.8.0", "Jesse Beder", "MIT", "https://github.com/jbeder/yaml-cpp/tree/0.8.0", "yaml-cpp-0.8.0.txt"],
  ["pystring", "1.1.4", "Contributors to the Pystring project", "BSD-3-Clause", "https://github.com/imageworks/pystring/tree/v1.1.4", "pystring-1.1.4.txt"],
  ["Imath", "3.2.1", "Contributors to the OpenEXR Project", "BSD-3-Clause", "https://github.com/AcademySoftwareFoundation/Imath/tree/v3.2.1", "Imath-3.2.1.txt"],
  ["zlib", "1.3.1", "Jean-loup Gailly and Mark Adler", "Zlib", "https://github.com/madler/zlib/tree/v1.3.1", "zlib-1.3.1.txt"],
  ["minizip-ng", "4.0.10", "Nathan Moinvaziri", "Zlib", "https://github.com/zlib-ng/minizip-ng/tree/4.0.10", "minizip-ng-4.0.10.txt"],
];

// --- the file ---
const fence = (text) => {
  // a fence longer than any backtick run in the text
  // loop: NOT-WORTH — one text's backtick runs
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const f = "`".repeat(longest + 1);
  return `${f}text\n${text}\n${f}`;
};
// an SPDX expression in one spelling for the summary: a plain choice ("Zlib OR MIT") with its terms sorted
// loop: NOT-WORTH — one expression's few terms
const family = (expr) => (/^[A-Za-z0-9.+-]+( OR [A-Za-z0-9.+-]+)*$/.test(expr) ? expr.split(" OR ").sort().join(" OR ") : expr);
const countBy = (list) => {
  const m = new Map();
  // loop: NOT-WORTH — ~110 entries
  for (const x of list) m.set(family(x.license), (m.get(family(x.license)) ?? 0) + 1);
  // loop: NOT-WORTH — a handful of families
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))
    .map(([f, n]) => `${f}: ${n}`)
    .join(" · ");
};
// loop: NOT-WORTH — one text's users
const users = (g) => g.users.map((u) => `${u.name} ${u.version}`).join(", ");

function render() {
  const rust = rustCrates();
  const npm = npmPackages();
  const dl = downloads();
  const pkg = JSON.parse(readFileSync(join(APP, "package.json"), "utf8"));
  const electron = JSON.parse(readFileSync(join(APP, "node_modules/electron/package.json"), "utf8")).version;
  if (electron !== pkg.devDependencies.electron) throw new Error(`gen_notices: node_modules has Electron ${electron}, package.json pins ${pkg.devDependencies.electron} (npm ci first)`);
  const L = [];
  L.push(
    "# Third-party notices",
    "",
    "CorridorKey Desktop is released under the CorridorKey licence (LICENSE). It depends on the third-party code and",
    "model weights below, which are not owned by the Licensor and are not covered by that licence; each remains under",
    "its own licence (LICENSE §6).",
    "",
    "This file is generated by `tools/gen_notices.mjs` from engine-rs/Cargo.lock (cargo-about), package-lock.json and",
    "electron/main/install.ts. Do not edit it by hand: run `node tools/gen_notices.mjs`.",
    "",
    "## Summary",
    "",
    "| Part | Ships in the app | Count | Licences |",
    "| --- | --- | --- | --- |",
    `| Engine (Rust crates) | yes | ${rust.crates.length} | ${countBy(rust.crates)} |`,
    `| Interface (npm packages) | yes | ${npm.packages.length} | ${countBy(npm.packages)} |`,
    // loop: NOT-WORTH — nine libraries, once per run
    `| OpenColorIO and its bundled C++ libraries (inside the engine) | yes | ${OCIO_LIBS.length} | ${countBy(OCIO_LIBS.map((l) => ({ license: l[3] })))} |`,
    `| Electron ${electron} with Chromium | yes | 1 | MIT (Electron); Chromium's own notices in LICENSES.chromium.html |`,
    "| TensorRT engine builder (ck-trt-build, Linux) | yes | 2 | Apache-2.0 (TensorRT headers); Apache-2.0 WITH LLVM-exception (LLVM libc++) |",
    `| GPU runtime, models | no: downloaded at first run from their publishers | ${dl.rows.length} wheels, 2 model sets | see below |`,
    "",
    "## Shipped inside the app",
    "",
    "### The engine (corridorkey-engine)",
    "",
    `The Rust crates linked into corridorkey-engine as the releases build it (tools/build_engine.sh: features`,
    `\`${ENGINE_FEATURES}\` on Linux and Windows, \`ort-dynamic,ocio\` on macOS; the union of the three targets).`,
    "Build-script and test-only crates are not linked and not listed; proc-macro crates run only while building and are",
    "listed anyway. The engine also links the Rust standard library (MIT OR Apache-2.0).",
    "",
    "| Crate | Version | Licence |",
    "| --- | --- | --- |",
  );
  // loop: NOT-WORTH — ~60 crates
  for (const c of rust.crates) L.push(`| ${c.name} | ${c.version} | ${c.license} |`);
  L.push(
    "",
    "### OpenColorIO and its bundled libraries (inside the engine)",
    "",
    "The engine's colour management is the OpenColorIO C++ library, built from source with the C++ libraries below and",
    "linked statically into corridorkey-engine on Linux and Windows (and on macOS once the engine is built there), through",
    "the ocio-rs / ocio-sys crates above (ocio-sys vendored with MinGW build fixes, engine-rs/vendor/README.md). Full",
    "licence texts under Licence texts.",
    "",
    "| Library | Version | Copyright | Licence | Source |",
    "| --- | --- | --- | --- | --- |",
    // loop: NOT-WORTH — nine libraries, once per run
    ...OCIO_LIBS.map(([name, version, holder, lic, url]) => `| ${name} | ${version} | ${holder} | ${lic} | ${url} |`),
    "",
    "The engine also links a C++ runtime for this code: on Linux the LLVM libc++ / libc++abi bundled with Zig 0.15.2",
    "(statically; Apache-2.0 WITH LLVM-exception, https://llvm.org/LICENSE.txt), on Windows MinGW-w64's GCC 13",
    "libstdc++ (statically; GPL-3.0-or-later WITH GCC-exception-3.1, the GCC Runtime Library Exception,",
    "https://www.gnu.org/licenses/gcc-exception-3.1.html), on macOS the system's libc++. The Windows engine also uses",
    "user32.dll and gdi32.dll, which are part of Windows (nothing to list).",
    "",
    "### The TensorRT engine builder (ck-trt-build, Linux)",
    "",
    "A small C++ program (engine-rs/tools/trt-build) that builds TensorRT engines for the opt-in TensorRT jobs. It is",
    "compiled with TensorRT 10.16's public headers, NVIDIA/TensorRT at d0faf303 and onnx/onnx-tensorrt at 6bde6596",
    "(SPDX-License-Identifier: Apache-2.0, Copyright (c) NVIDIA CORPORATION & AFFILIATES), and statically links the",
    "LLVM C++ runtime (libc++, libc++abi, libunwind) bundled with the Zig toolchain that builds it: Apache-2.0 WITH",
    "LLVM-exception (libc++ also under the legacy University of Illinois/NCSA licence), https://llvm.org/LICENSE.txt.",
    "TensorRT's libraries themselves are not shipped: they come with the opt-in TensorRT download (below).",
    "",
    "### The interface (npm packages)",
    "",
    "The production dependencies in package-lock.json: bundled by electron-vite into out/ and also copied into",
    "app.asar by electron-builder. Development tools (devDependencies) are not shipped and not listed.",
    "",
    "| Package | Version | Licence |",
    "| --- | --- | --- |",
  );
  // loop: NOT-WORTH — ~110 packages
  for (const p of npm.packages) L.push(`| ${p.name} | ${p.version} | ${p.text === null ? `${p.license} (no licence file in the package)` : p.license} |`);
  L.push(
    "",
    "### Electron and Chromium",
    "",
    `Electron ${electron} (MIT, Copyright (c) Electron contributors, Copyright (c) 2013-2020 GitHub Inc.) is the app's`,
    "runtime. Its licence and Chromium's third-party notices (Chromium, V8, FFmpeg as libffmpeg and the rest) ship with",
    "every copy of the app, unchanged, as Electron provides them:",
    "",
    "- Linux and Windows: `LICENSE.electron.txt` and `LICENSES.chromium.html` next to the app's executable (inside the",
    "  AppImage; in the install folder on Windows).",
    "- macOS: `CorridorKey.app/Contents/Resources/LICENSE.electron.txt` and `LICENSES.chromium.html`.",
    "",
    "## Downloaded at first run, not shipped",
    "",
    "The app's setup downloads these directly from their original sources onto the user's machine (each file pinned",
    "by size and SHA-256 in electron/main/install.ts); this app does not redistribute them. They stay under their",
    "publishers' licences; the wheels' own licence files are kept next to the libraries they unpack.",
    "",
    "### GPU runtime (Python wheels, unpacked; no Python is installed)",
    "",
    "| Package | Version | Systems | Licence | Source |",
    "| --- | --- | --- | --- | --- |",
    ...dl.rows,
    "",
    "### The CorridorKey models",
    "",
    `- The model set \`${dl.set}\` (and \`${dl.trtSet}\` for the opt-in TensorRT jobs): CorridorKey 2.0's five networks`,
    "  converted to ONNX from Corridor Digital's checkpoint, downloaded from this app's GitHub releases",
    `  (https://github.com/${dl.repo}/releases/tag/models-${dl.set}). CorridorKey 2.0 is © Corridor Digital, under the`,
    "  CorridorKey licence (https://github.com/nikopueringer/CorridorKey2.0).",
    "- **Modified:** every network is converted from the original PyTorch checkpoint to ONNX, with exact graph rewrites",
    "  for speed and portrait input (listed in the set's manifest.json); the fp16 files follow CorridorKey 2.0's own",
    "  precision policy (fp16 convolutions, matrix multiplies and attention; fp32 norms, softmax, exp/pow, sums and",
    "  upsampling); the TensorRT set adds TensorRT-specific rewrites. Each model release carries ATTRIBUTION.md, NOTICE",
    "  and the licence texts below.",
    "- Three of the five networks are foundation models. They stay under their publishers' licences, **not** under the",
    "  CorridorKey licence, with no added terms:",
    "  - **C-RADIOv4-SO400M**, NVIDIA Corporation (https://huggingface.co/nvidia/C-RADIOv4-SO400M, revision",
    "    `c0457f5dc26ca145f954cd4fc5bb6114e5705ad8`): the NVIDIA Open Model License (June 14, 2024; full text below).",
    "    Licensed by NVIDIA Corporation under the NVIDIA Open Model License.",
    "  - **MoGe-2 ViT-B (normal)**, Microsoft Corporation (https://github.com/microsoft/MoGe; weights",
    "    https://huggingface.co/Ruicheng/moge-2-vitb-normal, revision `ca5f0e07ff01d3e5a364c1d954ed12ee1814b368`): MIT,",
    "    Copyright (c) Microsoft Corporation (full text below); its DINOv2 backbone (Meta AI): Apache-2.0 (full text below).",
    "  - **RVM small** (Recurrent Video Masked Autoencoders, checkpoint `pretrain_rvm_small16_256_204031069`), © 2026",
    "    Google LLC (https://github.com/google-deepmind/representations4d): weights under Creative Commons Attribution 4.0",
    "    (https://creativecommons.org/licenses/by/4.0/), provided AS IS without warranties; code Apache-2.0. Paper: Zoran",
    '    et al., "Recurrent Video Masked Autoencoders", arXiv:2512.13684.',
    "- **A gift back:** CorridorKey Desktop is free and stays free, and it is offered back to Corridor Crew and the",
    "  CorridorKey community in full. Corridor is welcome to use, adopt or take over anything here; if anything isn't what",
    "  Corridor wants, it will be changed or taken down at their word.",
    "",
    "## System tools used, not shipped",
    "",
    "- ffmpeg and ffprobe: the system's copy, run as separate programs to read and write video; if missing, the app",
    "  offers to install it with the system's package manager (apt, pacman, winget's Gyan.FFmpeg, Homebrew). Under",
    "  ffmpeg's own licence (LGPL-2.1 or later, or GPL, depending on how that copy was built).",
    "- libjpeg-turbo (libturbojpeg): the system's copy, loaded at run time if present; under its own licence.",
    "",
    "## Licence texts",
    "",
    "Each distinct licence text once, with the components that ship it.",
    "",
    "### Rust crates",
    "",
  );
  // loop: NOT-WORTH — ~40 texts
  for (const g of rust.texts) L.push(`#### ${g.id}: ${users(g)}`, "", fence(g.text), "");
  L.push("### OpenColorIO and its bundled libraries", "");
  // loop: NOT-WORTH — nine licence files, once per generation
  for (const [name, version, , lic, , file] of OCIO_LIBS) L.push(`#### ${lic}: ${name} ${version}`, "", fence(readFileSync(join(APP, "licenses/ocio", file), "utf8").trimEnd()), "");
  L.push("### npm packages", "");
  // loop: NOT-WORTH — ~100 texts
  for (const g of npm.texts) L.push(`#### ${g.id}: ${users(g)}`, "", fence(g.text), "");
  L.push("### The foundation models", "");
  // loop: NOT-WORTH — three licence files, once per generation
  for (const [title, file] of [
    ["NVIDIA Open Model License (June 14, 2024): C-RADIOv4-SO400M", "licenses/models/NVIDIA-Open-Model-License-2024-06.txt"],
    ["MIT: MoGe-2 (Copyright (c) Microsoft Corporation)", "licenses/models/MoGe-MIT.txt"],
    ["Apache-2.0: DINOv2 (in MoGe-2), RVM code", "licenses/models/Apache-2.0.txt"],
  ])
    L.push(`#### ${title}`, "", fence(readFileSync(join(APP, file), "utf8").trimEnd()), "");
  return L.join("\n").replace(/\n+$/, "") + "\n";
}

const text = render();
if (process.argv.includes("--check")) {
  const now = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
  if (now !== text) {
    console.error("gen_notices: THIRD_PARTY_NOTICES.md is out of date; run node tools/gen_notices.mjs and commit it");
    process.exit(1);
  }
  console.log("gen_notices: THIRD_PARTY_NOTICES.md is current");
} else {
  writeFileSync(OUT, text);
  console.log(`gen_notices: wrote THIRD_PARTY_NOTICES.md (${Buffer.byteLength(text)} bytes)`);
}
