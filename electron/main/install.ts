// First-run install (BACKLOG row 2): the GPU runtime and the models, downloaded into the data folder
// (engineFind.ts dataDir) where the Engine page's lists find them. Nothing is hosted for the runtime:
// ONNX Runtime and NVIDIA's CUDA / cuDNN libraries come from PyPI as published wheels, pinned here by
// URL, size and SHA-256. The models come from this repository's `models-2.0.0-onnx.3` release
// (converted from Corridor Digital's checkpoint; CorridorKey licence). Every file is checked before use.
// After a Stop or a failure, pressing the button again resumes: finished files are checked offline and kept,
// a partial one continues where it stopped. A set only appears in the lists once all of it is in place
// (built in a `.partial-…` folder, then renamed; engineFind skips dot folders).
import type { EngineKind } from "../../src/shared/types";
import { gbBytes } from "../../src/shared/units";
import { lowerFirst, INSTALL_FIRST } from "../../src/shared/texts";
import { DOWNLOADS_DIR, LIBRARY_FILE, MODELS_DIR, PLATFORM, RUNTIME_DIR } from "./platform";
import { REPO } from "./updateFeed";
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { downloadVerified, type FetchFn } from "./download";
import { unzip } from "./unzip";

export interface Download {
  file: string;
  // what the progress line calls it ("NVIDIA cuDNN"); model files are named by `file`
  label?: string;
  url: string;
  size: number;
  sha256: string;
}

const PYPI = "https://files.pythonhosted.org/packages";
// The wheels of onnxruntime-gpu 1.31.0 and what it loads (the set measured in docs/ENGINE_RUST.md).
export const RUNTIME = {
  name: "ort-1.31.0-cuda13",
  wheels: [
    {
      label: "ONNX Runtime",
      file: "onnxruntime_gpu-1.31.0-cp312-cp312-manylinux_2_28_x86_64.whl",
      url: `${PYPI}/8f/48/6fbfdbce25e5756c7b9ff8f40645d98b166b8022cf00ede58a2bb4571b8e/onnxruntime_gpu-1.31.0-cp312-cp312-manylinux_2_28_x86_64.whl`,
      size: 255569162,
      sha256: "b52998a075de27ff30e46a125001822541fa5b03f5d31398ab0e50789d80c51c",
    },
    {
      label: "NVIDIA cuBLAS",
      file: "nvidia_cublas-13.8.1.7-py3-none-manylinux_2_27_x86_64.whl",
      url: `${PYPI}/eb/1b/adc70acf3fde509b1f0ca29d1c0e8d9b00aaecd871f8cf877257c8b68d9c/nvidia_cublas-13.8.1.7-py3-none-manylinux_2_27_x86_64.whl`,
      size: 439315821,
      sha256: "c11a27fd4379510e5b1f84b367a2514d1e52fe5cc13442117a0e0a1addee3cf2",
    },
    {
      label: "NVIDIA CUDA compiler (NVRTC)",
      file: "nvidia_cuda_nvrtc-13.4.92-py3-none-manylinux2010_x86_64.manylinux_2_12_x86_64.whl",
      url: `${PYPI}/56/9c/1342ebb460ce2afd014ec5a002adc99108e3c53a6b70f399cf64dd1f267d/nvidia_cuda_nvrtc-13.4.92-py3-none-manylinux2010_x86_64.manylinux_2_12_x86_64.whl`,
      size: 53301733,
      sha256: "5ce8c97b00b232c4f50c8c4b5a3b68cafee08bdb82ea86f2052ff01d03194f4a",
    },
    {
      label: "NVIDIA CUDA runtime",
      file: "nvidia_cuda_runtime-13.4.92-py3-none-manylinux2014_x86_64.manylinux_2_17_x86_64.whl",
      url: `${PYPI}/98/8a/3431271f6344874b8f1ac03f16b3d679c91493f8da63f716160403e6d0a0/nvidia_cuda_runtime-13.4.92-py3-none-manylinux2014_x86_64.manylinux_2_17_x86_64.whl`,
      size: 2494438,
      sha256: "9641f797da20ce1dd8e779b6e96d08cf9ba564cec8e8225458811ee26423f3a5",
    },
    {
      label: "NVIDIA cuDNN",
      file: "nvidia_cudnn_cu13-9.27.0.42-py3-none-manylinux_2_27_x86_64.whl",
      url: `${PYPI}/af/75/96ea5c5368eb595c39d629cde08a66227a864e71ccb0e593add2612bb952/nvidia_cudnn_cu13-9.27.0.42-py3-none-manylinux_2_27_x86_64.whl`,
      size: 536771498,
      sha256: "9677e76f21862eb5da7ee5ed69d544738b2d8b5c3ce7e5ec125c5592e6cdbdc8",
    },
    {
      label: "NVIDIA cuFFT",
      file: "nvidia_cufft-12.4.0.43-py3-none-manylinux2014_x86_64.manylinux_2_17_x86_64.whl",
      url: `${PYPI}/76/bf/3fea3d1c6262bded26ae00e3106432d63235954965d7785f5051ac146651/nvidia_cufft-12.4.0.43-py3-none-manylinux2014_x86_64.manylinux_2_17_x86_64.whl`,
      size: 161750089,
      sha256: "0e8385013596b112d29c9ce8c63dc575b308d77636c7169104e18714f03961a8",
    },
    {
      label: "NVIDIA cuRAND",
      file: "nvidia_curand-10.4.4.72-py3-none-manylinux_2_27_x86_64.whl",
      url: `${PYPI}/07/73/3ee8e5b4cb891401e603ffd3a59b35c6afe785fd2de123afe7c7029603dc/nvidia_curand-10.4.4.72-py3-none-manylinux_2_27_x86_64.whl`,
      size: 61498332,
      sha256: "25c3457ae7a224fdd484dab90b0fc5dc0e842fab5db3012afa4a5bd2af4eb7e5",
    },
    {
      label: "NVIDIA nvJitLink",
      file: "nvidia_nvjitlink-13.4.92-py3-none-manylinux2010_x86_64.manylinux_2_12_x86_64.whl",
      url: `${PYPI}/1d/6b/eef7a9e32872b8f41e145bf10cddc9af26e153c338852811fe9a9baddf9e/nvidia_nvjitlink-13.4.92-py3-none-manylinux2010_x86_64.manylinux_2_12_x86_64.whl`,
      size: 42452378,
      sha256: "e0391f24ed94ec879b84e3da4d4ec320c879aff681f2c7a638462f7199284323",
    },
  ] as Download[],
};

// The same set for Windows (the win_amd64 wheels; DLLs in onnxruntime/capi, nvidia/cudnn/bin, nvidia/cu13/bin/x86_64).
// cuBLAS 13.8.1.7 has no Windows wheel: 13.8.0.4, the same CUDA 13 line.
export const RUNTIME_WIN = {
  name: "ort-1.31.0-cuda13",
  wheels: [
    {
      label: "ONNX Runtime",
      file: "onnxruntime_gpu-1.31.0-cp312-cp312-win_amd64.whl",
      url: `${PYPI}/7e/ff/035730b399eea860df5952a76cc489cb34a663e5341eb6f53d892a5f7f2c/onnxruntime_gpu-1.31.0-cp312-cp312-win_amd64.whl`,
      size: 168098204,
      sha256: "e6bd756a3022a1a5a0217f35814e40e6e04fd1e497a5be78f991f6bfefad2fba",
    },
    {
      label: "NVIDIA cuBLAS",
      file: "nvidia_cublas-13.8.0.4-py3-none-win_amd64.whl",
      url: `${PYPI}/a3/df/f1246959833e2c437db8be3e5b477f66b87f8817821ed40de6c7561c9a36/nvidia_cublas-13.8.0.4-py3-none-win_amd64.whl`,
      size: 423266897,
      sha256: "8c5494423bb8a46822cb6b0cb95d7fa4be2d7b96a31155dff083839ec8297910",
    },
    {
      label: "NVIDIA CUDA compiler (NVRTC)",
      file: "nvidia_cuda_nvrtc-13.4.92-py3-none-win_amd64.whl",
      url: `${PYPI}/64/5b/aa91896f64444eff1dd7f189f4db05046c7f0ba08c0f531283c1c1aac581/nvidia_cuda_nvrtc-13.4.92-py3-none-win_amd64.whl`,
      size: 46972283,
      sha256: "6af7ac5372920f6a7a560d0699348560fe44cb52c1d722d6afd3119f8af948c4",
    },
    {
      label: "NVIDIA CUDA runtime",
      file: "nvidia_cuda_runtime-13.4.92-py3-none-win_amd64.whl",
      url: `${PYPI}/86/00/d5436004268f049214193659ebc36550b5ef3925c3d13b4cc980e13be6f5/nvidia_cuda_runtime-13.4.92-py3-none-win_amd64.whl`,
      size: 2778543,
      sha256: "08dca5e4aba480c2fd5b55075c0fa71b84ef9dcf0521f2d58baa14a803a7311c",
    },
    {
      label: "NVIDIA cuDNN",
      file: "nvidia_cudnn_cu13-9.27.0.42-py3-none-win_amd64.whl",
      url: `${PYPI}/87/6a/e55ff0ac26a5c6e2b21f41c9d04ad096b4ed6da593fba7e25845c61b0532/nvidia_cudnn_cu13-9.27.0.42-py3-none-win_amd64.whl`,
      size: 436469905,
      sha256: "7d96f634adafd55c72231eb0500ca77ab109ec8ebff7b33000b76e081bc4558e",
    },
    {
      label: "NVIDIA cuFFT",
      file: "nvidia_cufft-12.4.0.43-py3-none-win_amd64.whl",
      url: `${PYPI}/7b/cc/be7fe31058127336a66c88414a2ecc6beecf680baf85994a43eaf292b202/nvidia_cufft-12.4.0.43-py3-none-win_amd64.whl`,
      size: 160953139,
      sha256: "4ff7075f2d0b5f69291f70938d37a86ec632cbe5747184c74ba1f50f17accacc",
    },
    {
      label: "NVIDIA cuRAND",
      file: "nvidia_curand-10.4.4.72-py3-none-win_amd64.whl",
      url: `${PYPI}/e2/d4/f59ab342b82ff05ff27d674acd470ba625d788bf71338f7da6c89669d6b9/nvidia_curand-10.4.4.72-py3-none-win_amd64.whl`,
      size: 56731059,
      sha256: "e0bce83e083ef25976ee74f59e8f067c15149a74538f1be6c2462e286e7c9c68",
    },
    {
      label: "NVIDIA nvJitLink",
      file: "nvidia_nvjitlink-13.4.92-py3-none-win_amd64.whl",
      url: `${PYPI}/72/7c/c44bd7277afafed9de262a23baec4dc8dcf7ecbb1b9ecb228821442d1e9b/nvidia_nvjitlink-13.4.92-py3-none-win_amd64.whl`,
      size: 39053950,
      sha256: "b286f3a4f227a9363efdec263c7b91788cef1478d2b8a5fa8bab7f3e82ff82fd",
    },
    // onnxruntime.dll needs Microsoft's Visual C++ 2015-2022 runtime (msvcp140, vcruntime140 and their _1 parts),
    // which a fresh Windows doesn't have (found in the Windows VM 2026-10-24: "LoadLibraryExW failed"). Microsoft's
    // redistributable DLLs, unmodified, from PyPI's msvc-runtime wheel; the engine finds them on its PATH (engine.ts).
    {
      label: "Microsoft Visual C++ runtime",
      file: "msvc_runtime-14.51.36231-cp312-cp312-win_amd64.whl",
      url: `${PYPI}/98/33/be9ef68901200813fc174a06758b4ae48ca4eb58fa783280dd879d5fd048/msvc_runtime-14.51.36231-cp312-cp312-win_amd64.whl`,
      size: 2052033,
      sha256: "89f70d1a37bb64164cdb09d02dd82d6b1400e1310be2995b4ed5a9f23efe2222",
    },
  ] as Download[],
};

// macOS (Apple Silicon): the plain onnxruntime wheel; its library has the Core ML execution provider built in
// (Apple's GPU and Neural Engine), and macOS has no CUDA, so nothing else is needed.
export const RUNTIME_MAC = {
  name: "ort-1.31.0-coreml",
  wheels: [
    {
      label: "ONNX Runtime",
      file: "onnxruntime-1.31.0-cp312-cp312-macosx_14_0_arm64.whl",
      url: `${PYPI}/b3/bd/2ac094311163b803e3626c3937461d6900934bd56cca7601f6150ff860c3/onnxruntime-1.31.0-cp312-cp312-macosx_14_0_arm64.whl`,
      size: 20882054,
      sha256: "aaab9b3af536b06ca27ab5e35e3d429c97457ce76cf298af103f687e8b9975c0",
    },
  ] as Download[],
};

/** The runtime this system downloads. */
export function runtimeFor(platform: NodeJS.Platform) {
  return platform === "win32" ? RUNTIME_WIN : platform === "darwin" ? RUNTIME_MAC : RUNTIME;
}

/** Can this system run the engine on its graphics hardware, and what the setup downloads for it. */
export interface SystemSupport {
  ok: boolean;
  // why not, in the user's words (null when ok)
  problem: string | null;
  // the runtime download, as the setup page describes it
  runtime: string;
  // what it is, in a few words (App settings, Storage)
  runtimeShort: string;
}

const NVIDIA_RUNTIME = "ONNX Runtime (Microsoft, MIT licence) and NVIDIA's CUDA and cuDNN libraries (NVIDIA licence), from pypi.org";

/**
 * Linux: the NVIDIA driver's proc file; Windows: its NVML library in System32; macOS: Apple Silicon (Core ML runs
 * on its GPU and Neural Engine; there is no Intel Mac build).
 */
export function systemSupport(platform: NodeJS.Platform, arch: string, exists: (p: string) => boolean, env: NodeJS.ProcessEnv): SystemSupport {
  if (platform === "darwin") {
    const ok = arch === "arm64";
    return {
      ok,
      problem: ok ? null : "This Mac has an Intel processor. CorridorKey Desktop runs on Macs with Apple Silicon (M1 or newer).",
      runtime: "ONNX Runtime (Microsoft, MIT licence) with Apple's Core ML, from pypi.org",
      runtimeShort: "ONNX Runtime with Core ML",
    };
  }
  // loop: NOT-WORTH — one stat of the NVIDIA driver's file per check
  const ok = platform === "win32" ? exists(join(env.SystemRoot || "C:\\Windows", "System32", "nvml.dll")) : exists("/proc/driver/nvidia/version");
  return { ok, problem: ok ? null : "No NVIDIA graphics driver is loaded. CorridorKey Desktop runs on NVIDIA graphics cards.", runtime: NVIDIA_RUNTIME, runtimeShort: "ONNX Runtime, CUDA, cuDNN" };
}

/** What to keep from a wheel: ONNX Runtime's libraries, NVIDIA's libraries, and every licence file. */
export function keepFromWheel(name: string): boolean {
  // Linux also keeps ONNX Runtime's TensorRT provider (1 MB, in the wheel already downloaded): the opt-in TensorRT
  // install then needs only NVIDIA's TensorRT libraries and the TensorRT models (installs from before 1.0 fetch it then)
  if (/^onnxruntime\/capi\/libonnxruntime(\.so\.|_providers_(cuda|shared|tensorrt)\.so$)/.test(name)) return true;
  // Windows: the DLLs (the TensorRT provider stays out: TensorRT is Linux-only in 1.0)
  if (/^onnxruntime\/capi\/onnxruntime(_providers_(cuda|shared))?\.dll$/.test(name)) return true;
  if (/^nvidia\/[^/]+\/bin\/(x86_64\/)?[^/]+\.dll$/.test(name)) return true;
  // the package's metadata: the Engine page reads ONNX Runtime's version from its dist-info folder on Windows
  if (/^onnxruntime(_gpu)?-[\d.]+\.dist-info\/METADATA$/.test(name)) return true;
  if (/^nvidia\/[^/]+\/lib\/[^/]+\.so[.\d]*$/.test(name)) return true;
  // Windows: the Visual C++ runtime ONNX Runtime needs (msvc_runtime-<version>.data/data/Scripts/)
  if (/^msvc_runtime-[\d.]+\.data\/data\/Scripts\/(msvcp140[^/]*|vcruntime140[^/]*)\.dll$/.test(name)) return true;
  // macOS: libonnxruntime.1.31.0.dylib
  if (/^onnxruntime\/capi\/libonnxruntime\.[\d.]+\.dylib$/.test(name)) return true;
  // ONNX Runtime's own licence and third-party notices (the macOS wheel keeps them in the package folder)
  if (/^onnxruntime\/(LICENSE|ThirdPartyNotices\.txt)$/.test(name)) return true;
  return /\.dist-info\/(licenses\/.+|LICENSE[^/]*)$/i.test(name);
}

// the model set, and this repository's release that holds it (models-<set>)
const MODEL_SET = "2.0.0-onnx.3";
const release = (set: string) => `https://github.com/${REPO}/releases/download/models-${set}`;
const inRelease =
  (set: string) =>
  (file: string, size: number, sha256: string): Download => ({ file, url: `${release(set)}/${file}`, size, sha256 });
const model = inRelease(MODEL_SET);
export const MODELS = {
  name: MODEL_SET,
  files: [
    model("ck2-cradio-fp16.onnx", 789360, "25e8656dffc2c639f1557b092ea5d2738d7c4002b495195f93ba41a3610b0334"),
    model("ck2-cradio-fp16.onnx.data", 1724414688, "8f76c92ddf779b70745fc985820e7e312f7eb07ec82b4e20119062798f952b9f"),
    model("ck2-moge-fp16.onnx", 848115, "7c6ebfee3e359ee40b8dfc5415735040813bcfec3715ad4b6f1fc822a45574a3"),
    model("ck2-moge-fp16.onnx.data", 175527936, "00926e6df6998730443d8592bff4fafc182a3731f212b25c81c3bec0d14cd509"),
    model("ck2-rvm-fp16.onnx", 1039306, "9c98927b5dfad26895031186e5aeeaf6370d8f1d4354381779c16e0840922259"),
    model("ck2-rvm-fp16.onnx.data", 66509824, "65fed0108ad965067875b10b83110981a9768590492eb09046815b8e05ca0fe2"),
    model("ck2-stage1-fp16.onnx", 4660818, "ef86e7418f2667171e0272880c70add78a1e722e063a74571897cf71eaf27e96"),
    model("ck2-stage1-fp16.onnx.data", 924062976, "5c2fc34c4c13ca811e4ba8998ff97a04f9fca6b7518f57caa83531fd04e13e98"),
    model("ck2-stage2-fp16.onnx", 2255708, "ebbab0f697738aeab07b3704d4f4ce335243102680805f465f4eac76abefd567"),
    model("ck2-stage2-fp16.onnx.data", 404083200, "00fdee0b2ce58e824fe75e09c3c6cddb4b022a5c1e0b2f4789f1487873e6d890"),
    model("manifest.json", 16110, "97340927f91072330fcfbac9d01c10a32c8db3f129881ffd57a3c62e0a0428ca"),
    model("models.json", 395, "01f0d8e592d10a9459f72ce23ebfaded0b56168b6d838799a0dad8172fe9ebff"),
  ],
};

// loop: NOT-WORTH — sums a dozen sizes, once per plan
const total = (d: Download[]) => d.reduce((n, x) => n + x.size, 0);
// the install's refusals, the same for the runtime and models and for TensorRT's parts
const noRoom = (need: number, dir: string, free: number) => new Error(`not enough free disk space: it needs ${gbBytes(need)} in ${dir}, ${gbBytes(free)} is free`);
const noLibraries = (file: string) => new Error(`${file} had none of the expected libraries`);
export const RUNTIME_BYTES = total(runtimeFor(PLATFORM).wheels);
export const MODELS_BYTES = total(MODELS.files);

/** What gets installed: the pinned runtime and model set (tests pass a small one). */
export interface Catalog {
  runtime: { name: string; wheels: Download[] };
  models: { name: string; files: Download[] };
}
const CATALOG: Catalog = { runtime: runtimeFor(PLATFORM), models: MODELS };

/** What is still to install: each set is there once its folder is (the rename is the last step). */
export function installNeeds(data: string, exists: (p: string) => boolean = existsSync, c: Catalog = CATALOG): { runtime: boolean; models: boolean; bytes: number } {
  const runtime = !exists(join(data, RUNTIME_DIR, c.runtime.name));
  const models = !exists(join(data, MODELS_DIR, c.models.name));
  return { runtime, models, bytes: (runtime ? total(c.runtime.wheels) : 0) + (models ? total(c.models.files) : 0) };
}

export interface InstallDeps {
  fetch: FetchFn;
  // bytes done of the whole install, and what is happening ("Downloading cuDNN…")
  progress: (done: number, total: number, step: string) => void;
  abort: AbortSignal;
  // free bytes where `data` is (null: unknown, don't check)
  freeBytes: (dir: string) => number | null;
}

/** Free bytes on the disk holding `dir`. */
export function freeBytes(dir: string): number | null {
  try {
    // loop: NOT-WORTH — one statfs per install start
    const s = statfsSync(dir);
    return s.bavail * s.bsize;
  } catch {
    // error: NOT-WORTH — unknown: the install goes ahead and a full disk is reported when it happens
    return null;
  }
}

/**
 * One verified, resumable download at a time, counted into one progress number of `bytes` (`counted` false: a file
 * already on this disk, checked offline, which the plan didn't count as a download).
 */
function fetcher(deps: InstallDeps, bytes: number, downloads: string) {
  let done = 0;
  const fetchOne = async (d: Download, step: string, path = join(downloads, d.file), counted = true) => {
    // loop: SERIAL-REQUIRED — one file at a time: the line is the limit, and progress stays one honest number
    await downloadVerified(
      deps.fetch,
      { url: d.url, size: d.size, sha256: d.sha256, source: "the app's list" },
      path,
      (got) => counted && deps.progress(done + got, bytes, step),
      deps.abort,
      undefined,
      { resume: true },
    );
    if (counted) done += d.size;
  };
  return { fetchOne, done: () => done };
}

/** Download and unpack whatever is missing. Resumable: run it again after a stop or a failure. */
// loop: NOT-WORTH — a few rmSync / mkdir / rename calls per install (local disk)
export async function runInstall(data: string, deps: InstallDeps, c: Catalog = CATALOG): Promise<void> {
  const need = installNeeds(data, existsSync, c);
  const RUNTIME = c.runtime;
  const MODELS = c.models;
  // room for it all: the wheels and their unpacked libraries side by side, then the models (the unpacked runtime
  // is ~1.5× its wheels); refused up front instead of failing halfway with a disk-full error
  // loop: NOT-WORTH — one mkdir per install (the disk check needs the folder)
  mkdirSync(data, { recursive: true });
  const room = deps.freeBytes(data);
  const needRoom = (need.runtime ? total(RUNTIME.wheels) * 2.5 : 0) + (need.models ? total(MODELS.files) : 0);
  if (room !== null && room < needRoom) throw noRoom(needRoom, data, room);
  const downloads = join(data, DOWNLOADS_DIR);
  // loop: NOT-WORTH — one mkdir per install
  mkdirSync(downloads, { recursive: true });
  // a model file downloads straight into the set's .partial folder, so a stopped install keeps the checked ones
  const { fetchOne, done } = fetcher(deps, need.bytes, downloads);

  if (need.runtime) {
    const partial = join(data, RUNTIME_DIR, `.partial-${RUNTIME.name}`);
    // loop: NOT-WORTH — clears a half-unpacked runtime once per install
    rmSync(partial, { recursive: true, force: true });
    // loop: SERIAL-REQUIRED — one wheel at a time (download, then unpack), see fetchOne
    for (const w of RUNTIME.wheels) {
      const label = w.label ?? w.file;
      await fetchOne(w, `Downloading ${label}`);
      deps.progress(done(), need.bytes, `Unpacking ${label}`);
      // loop: SERIAL-REQUIRED — unpacks one wheel [bounded: its size]
      const unpacked = await unzip(join(downloads, w.file), partial, keepFromWheel, deps.abort);
      // licence files alone don't count: a wheel must give at least one library
      // loop: NOT-WORTH — the few names one wheel unpacked
      if (!unpacked.some((n) => LIBRARY_FILE.test(n))) throw noLibraries(w.file);
    }
    // loop: NOT-WORTH — one rename: the runtime appears whole
    renameSync(partial, join(data, RUNTIME_DIR, RUNTIME.name));
  }
  // the wheels once the runtime is in place (also after a crash between the rename and this cleanup)
  // loop: NOT-WORTH — eight local unlinks, once per install
  if (existsSync(join(data, RUNTIME_DIR, RUNTIME.name))) for (const w of RUNTIME.wheels) rmSync(join(downloads, w.file), { force: true });

  if (need.models) {
    const partial = join(data, MODELS_DIR, `.partial-${MODELS.name}`);
    // loop: NOT-WORTH — one mkdir per install
    mkdirSync(partial, { recursive: true });
    // loop: SERIAL-REQUIRED — one file at a time, see fetchOne
    // (a file already there from a stopped install is checked offline and kept: downloadVerified's resume)
    for (const f of MODELS.files) await fetchOne(f, `Downloading the CorridorKey models (${f.file})`, join(partial, f.file));
    // loop: NOT-WORTH — one rename: the model set appears whole
    renameSync(partial, join(data, MODELS_DIR, MODELS.name));
  }
  // loop: NOT-WORTH — one readdir of the (now empty) downloads folder
  if (readdirSync(downloads).length === 0) rmSync(downloads, { recursive: true, force: true });
}

// TensorRT (opt-in, Linux only in 1.0; docs/ENGINE_RUST.md "TensorRT"): three parts, each put where the engine
// already looks, so the engine needs no new setting:
//   libraries: NVIDIA's tensorrt-cu13-libs wheel (pypi.nvidia.com), only what ck-trt-build and ONNX Runtime's
//     TensorRT provider load, as <runtime>/tensorrt_libs (engine.ts rustEngineEnv puts it on LD_LIBRARY_PATH);
//   provider: libonnxruntime_providers_tensorrt.so next to libonnxruntime (the runtime install keeps it since 1.0;
//     a runtime installed before that gets it from the ONNX Runtime wheel again);
//   models: the TensorRT-ready set (release models-2.0.0-onnx.3-trt) in the normal set's folder, its models.json keys
//     merged into the set's: the engine finds TensorRT files only through its one --models folder's models.json
//     (engine-rs runtime.rs ModelSet::trt_file / trt_stub). The set's own models.json stays as models-tensorrt.json:
//     the list of what is TensorRT's (Storage removes exactly that) and the mark that the set is whole (written last).
export const TRT_PROVIDER = "libonnxruntime_providers_tensorrt.so";
export const TRT_LIBS_DIR = "tensorrt_libs";
export const TRT_MODELS_LIST = "models-tensorrt.json";
/** The wheel's licence folder, kept next to the libraries. */
export const TRT_DIST_INFO = /^tensorrt_cu\d+_libs-[\d.]+\.dist-info$/;
const TRT_MODEL_SET = "2.0.0-onnx.3-trt";
const trtModel = inRelease(TRT_MODEL_SET);
export const TENSORRT = {
  libs: {
    label: "NVIDIA TensorRT",
    file: "tensorrt_cu13_libs-10.16.1.11-py3-none-manylinux_2_28_x86_64.whl",
    url: "https://pypi.nvidia.com/tensorrt-cu13-libs/tensorrt_cu13_libs-10.16.1.11-py3-none-manylinux_2_28_x86_64.whl",
    size: 3728705565,
    sha256: "91142c8ab3c58bed213cf1a563a6eb4e4f0ac529d05b5f909073acece0e3b712",
  } as Download,
  models: {
    name: TRT_MODEL_SET,
    files: [
      trtModel("ck2-cradio-trt-fp16-ctx.onnx", 600, "6276830bfeaa0226819f27064eb22c29e1fdad6ae5e4b16d2ed7daa4347b8cb9"),
      trtModel("ck2-cradio-trt-fp16.onnx", 742927, "1e6acbb7e9bd5f5fffe19fab97fbb5df3e9627b7082b4b7846b239f77ecfbe7a"),
      // the same bytes as the normal set's ck2-cradio-fp16.onnx.data: copied from it, not downloaded (localTwin)
      trtModel("ck2-cradio-trt-fp16.onnx.data", 1724414688, "8f76c92ddf779b70745fc985820e7e312f7eb07ec82b4e20119062798f952b9f"),
      trtModel("ck2-moge-trt-fp16-ctx.onnx", 598, "66a27beb74a7141af4e847827df84aac8fe7ea0eee5d9a91e888dc89f4fb2325"),
      trtModel("ck2-moge-trt-fp16.onnx", 758942, "f829f950d01b66a0f85bbe0b61eebfbd2785934cac1707ad383c39fc40057338"),
      trtModel("ck2-moge-trt-fp16.onnx.data", 348664320, "594e001b6fedc6fde1f43f654c4f317f4f2392b59d65bb8be3593852d7a31450"),
      trtModel("ck2-rvm-trt-fp16-ctx.onnx", 994, "754658db43823a5175cde0873bfcd2b249aec89c4918298fd26ab3a63c14852c"),
      trtModel("ck2-rvm-trt-fp16.onnx", 844775, "b84a19f10febb5a8e84dc379a23b6749104b79fef0dda944cba625a72af18135"),
      trtModel("ck2-rvm-trt-fp16.onnx.data", 132768256, "e03b51246f2ec801857f0611b6421da7a521b7a3bcc768a97e0c7388d2d1aa67"),
      trtModel("ck2-stage1-trt-fp16-ctx.onnx", 1785, "5b27c10f7ae9493f228e40adeee57a83b21c5c40b4903dfe659f7130572848a9"),
      trtModel("ck2-stage1-trt-fp16.onnx", 4140214, "530047e1e485b434317cdb1121b041df4ba886f68d63391225251dda8f5d9414"),
      trtModel("ck2-stage1-trt-fp16.onnx.data", 1843256576, "9a7ec9640197594da2da1128bea93b1d0342bac47fc17db7d9485bf794d6205f"),
      trtModel("ck2-stage2-trt-fp16-ctx.onnx", 843, "2eb0af9f07b7e7a380efcedc98cc314fa13162d51f3b9c17234c39ff9d9ac381"),
      trtModel("ck2-stage2-trt-fp16.onnx", 1992893, "5f36395d344f88fa71d37afdd6445a9f7aa538ce8746b06b696b469578abab96"),
      trtModel("ck2-stage2-trt-fp16.onnx.data", 804806144, "280baab4bf70bd4398b8f257c85ce0e8b85fbd21c22bdcfe4c29690d6378212b"),
      // last: it becomes models-tensorrt.json once every file is in place (TRT_MODELS_LIST)
      trtModel("models.json", 476, "c5d65827ad8043fd67915d9cc37ff2110c559ce60450da86742de8c81eb74643"),
    ],
  },
};

/**
 * What to keep from NVIDIA's TensorRT wheel: the runtime (libnvinfer), the ONNX parser and the plugins, the builder's
 * kernels for Linux (Turing sm75 to Blackwell sm120, PTX for newer cards; the win_ ones only build Windows engines),
 * and the licence: 2.6 GB of the wheel's 4.4 GB.
 */
export function keepTensorrt(name: string): boolean {
  if (/^tensorrt_libs\/lib(nvinfer|nvinfer_plugin|nvonnxparser)\.so\.\d+$/.test(name)) return true;
  if (/^tensorrt_libs\/libnvinfer_builder_resource_(ptx|sm\d+)\.so\.[\d.]+$/.test(name)) return true;
  return /^tensorrt_cu\d+_libs-[\d.]+\.dist-info\/LICENSE[^/]*$/.test(name);
}

/** What the TensorRT install puts on top of an installed runtime and model set (tests pass a small one). */
export interface TrtCatalog extends Catalog {
  libs: Download;
  trtModels: { name: string; files: Download[] };
}
const TRT_CATALOG: TrtCatalog = { ...CATALOG, libs: TENSORRT.libs, trtModels: TENSORRT.models };

/** Where the TensorRT parts go: into the installed runtime and model set. */
export function trtPaths(data: string, c: Catalog = TRT_CATALOG) {
  const runtime = join(data, RUNTIME_DIR, c.runtime.name);
  const models = join(data, MODELS_DIR, c.models.name);
  return { runtime, libs: join(runtime, TRT_LIBS_DIR), provider: join(runtime, "onnxruntime", "capi", TRT_PROVIDER), models, list: join(models, TRT_MODELS_LIST) };
}

/** A TensorRT file the normal set already has (C-RADIO's weights are the same bytes): copied, not downloaded. */
function localTwin(f: Download, c: Catalog): Download | undefined {
  // loop: NOT-WORTH — a dozen model files, once per plan
  return c.models.files.find((m) => m.sha256 === f.sha256 && m.size === f.size);
}

/** The ONNX Runtime wheel, which holds the TensorRT provider. */
function ortWheel(c: Catalog): Download {
  // loop: NOT-WORTH — eight wheels, once per plan
  const w = c.runtime.wheels.find((x) => /^onnxruntime/.test(x.file));
  if (!w) throw new Error("this system's runtime has no ONNX Runtime wheel");
  return w;
}

export interface TrtNeeds {
  libs: boolean;
  provider: boolean;
  models: boolean;
  // what is still to download (files the normal set already has are copied, not counted)
  bytes: number;
}

/** What the TensorRT install still has to do (each part is there once its last step ran). */
export function trtNeeds(data: string, exists: (p: string) => boolean = existsSync, c: TrtCatalog = TRT_CATALOG): TrtNeeds {
  const p = trtPaths(data, c);
  const libs = !exists(p.libs);
  const provider = !exists(p.provider);
  const models = !exists(p.list);
  const copied = (f: Download) => {
    const twin = localTwin(f, c);
    return !!twin && exists(join(p.models, twin.file));
  };
  // loop: NOT-WORTH — sixteen model files, once per plan
  const modelBytes = total(c.trtModels.files.filter((f) => !copied(f)));
  return { libs, provider, models, bytes: (libs ? c.libs.size : 0) + (provider ? ortWheel(c).size : 0) + (models ? modelBytes : 0) };
}

// loop: NOT-WORTH — sixteen model files, once at load
const TRT_MODEL_DOWNLOAD = TENSORRT.models.files.filter((f) => !localTwin(f, CATALOG));
/** The TensorRT download on top of a 1.0 runtime and model set (what the setting's hint names). */
export const TRT_BYTES = TENSORRT.libs.size + total(TRT_MODEL_DOWNLOAD);

/**
 * The TensorRT parts are there for the files the engine runs with (its ONNX Runtime library and models folder): only
 * then does a job ask for TensorRT.
 */
export function trtReady(ort: string | null, models: string | null, exists: (p: string) => boolean = existsSync): boolean {
  if (!ort || !models) return false;
  const capi = dirname(ort);
  // loop: NOT-WORTH — three stats per check
  return exists(join(capi, TRT_PROVIDER)) && exists(join(dirname(dirname(capi)), TRT_LIBS_DIR)) && exists(join(models, TRT_MODELS_LIST));
}

/** TensorRT in 1.0: Linux (Windows needs its own engine builder, later; macOS has no TensorRT). */
export const trtSupported = (platform: NodeJS.Platform) => platform === "linux";

/** Whether a job asks the engine for TensorRT: Linux, the setting on, the Rust engine (never PyTorch), its parts installed. */
export function useTensorrt(s: { platform: NodeJS.Platform; setting: boolean; engine: EngineKind | null; ready: boolean }): boolean {
  return trtSupported(s.platform) && s.setting && s.engine === "rust" && s.ready;
}

/**
 * Why a job doesn't ask for TensorRT, in the words the job page shows (useTensorrt's conditions, in order). Null when
 * it asks, and where TensorRT doesn't exist in this version (Windows, macOS): nothing to decide there.
 */
export function tensorrtWhyNot(s: { platform: NodeJS.Platform; setting: boolean; engine: EngineKind | null; ready: boolean }): string | null {
  if (!trtSupported(s.platform) || useTensorrt(s)) return null;
  if (!s.setting) return "TensorRT is off (Engine settings)";
  if (s.engine !== "rust") return "TensorRT runs on the ONNX Runtime engine only, not the PyTorch engine";
  return "TensorRT's parts weren't installed when the job started (Engine settings, TensorRT)";
}

/** models.json as the engine reads it: {"<precision or tensorrt-…>": {"<network>": "<file>"}}. */
type ModelsJson = Record<string, Record<string, string>>;
// loop: NOT-WORTH — reads one small models.json per install / removal
const readJson = (p: string): ModelsJson => JSON.parse(readFileSync(p, "utf8")) as ModelsJson;
/** Write a file whole or not at all (temp file + rename). */
function writeAtomic(p: string, text: string): void {
  // loop: NOT-WORTH — one small file written once per install / removal
  writeFileSync(`${p}.tmp`, text);
  // loop: NOT-WORTH — one rename, as above
  renameSync(`${p}.tmp`, p);
}

/** Download and put in place whatever TensorRT part is missing. Resumable, as runInstall. */
export async function runTrtInstall(data: string, deps: InstallDeps, c: TrtCatalog = TRT_CATALOG): Promise<void> {
  const p = trtPaths(data, c);
  // loop: NOT-WORTH — two stats per install start
  if (!existsSync(p.runtime) || !existsSync(p.models)) throw new Error(lowerFirst(INSTALL_FIRST));
  const need = trtNeeds(data, existsSync, c);
  // room: the wheel and its kept libraries side by side (2.6 of 3.7 GB), the ONNX Runtime wheel, the models (copies included)
  const room = deps.freeBytes(data);
  const needRoom = (need.libs ? c.libs.size * 1.8 : 0) + (need.provider ? ortWheel(c).size : 0) + (need.models ? total(c.trtModels.files) : 0);
  if (room !== null && room < needRoom) throw noRoom(needRoom, data, room);
  const downloads = join(data, DOWNLOADS_DIR);
  // loop: NOT-WORTH — one mkdir per install
  mkdirSync(downloads, { recursive: true });
  const { fetchOne, done } = fetcher(deps, need.bytes, downloads);

  if (need.libs) {
    const partial = join(p.runtime, `.partial-${TRT_LIBS_DIR}`);
    // loop: NOT-WORTH — clears a half-unpacked TensorRT once per install
    rmSync(partial, { recursive: true, force: true });
    await fetchOne(c.libs, `Downloading ${c.libs.label}`);
    deps.progress(done(), need.bytes, `Unpacking ${c.libs.label}`);
    // loop: SERIAL-REQUIRED — unpacks one wheel [bounded: its size]
    const unpacked = await unzip(join(downloads, c.libs.file), partial, keepTensorrt, deps.abort);
    // loop: NOT-WORTH — the few names the wheel unpacked
    if (!unpacked.some((n) => /^tensorrt_libs\/libnvinfer\.so\./.test(n))) throw noLibraries(c.libs.file);
    // the licence folder first, the libraries last: the folder's rename is the mark that they are in place
    // loop: NOT-WORTH — the partial folder's two entries
    for (const d of readdirSync(partial).filter((n) => TRT_DIST_INFO.test(n))) {
      // loop: NOT-WORTH — one licence folder replaced
      rmSync(join(p.runtime, d), { recursive: true, force: true });
      // loop: NOT-WORTH — one rename
      renameSync(join(partial, d), join(p.runtime, d));
    }
    // loop: NOT-WORTH — one rename: the libraries appear whole
    renameSync(join(partial, TRT_LIBS_DIR), p.libs);
    // loop: NOT-WORTH — removes the emptied partial folder
    rmSync(partial, { recursive: true, force: true });
  }
  // loop: NOT-WORTH — one local unlink once the libraries are in place (also after a crash before it)
  if (existsSync(p.libs)) rmSync(join(downloads, c.libs.file), { force: true });

  if (need.provider) {
    const w = ortWheel(c);
    const partial = join(p.runtime, ".partial-tensorrt-provider");
    // loop: NOT-WORTH — clears a half-unpacked provider once per install
    rmSync(partial, { recursive: true, force: true });
    await fetchOne(w, `Downloading ${w.label ?? w.file} (its TensorRT part)`);
    // loop: SERIAL-REQUIRED — unpacks one file from the wheel [bounded: its size]
    await unzip(join(downloads, w.file), partial, (n) => n === `onnxruntime/capi/${TRT_PROVIDER}`, deps.abort);
    const got = join(partial, "onnxruntime", "capi", TRT_PROVIDER);
    // loop: NOT-WORTH — one stat
    if (!existsSync(got)) throw new Error(`${w.file} had no ${TRT_PROVIDER}`);
    // loop: NOT-WORTH — one rename: the provider appears whole
    renameSync(got, p.provider);
    // loop: NOT-WORTH — removes the partial folder and the wheel (local unlinks)
    rmSync(partial, { recursive: true, force: true });
    // loop: NOT-WORTH — as above
    rmSync(join(downloads, w.file), { force: true });
  }

  if (need.models) {
    const partial = join(data, MODELS_DIR, `.partial-${c.trtModels.name}`);
    // loop: NOT-WORTH — one mkdir per install
    mkdirSync(partial, { recursive: true });
    // loop: SERIAL-REQUIRED — one file at a time, see fetcher
    for (const f of c.trtModels.files) {
      const target = join(partial, f.file);
      const twin = localTwin(f, c);
      const twinPath = twin ? join(p.models, twin.file) : null;
      // loop: NOT-WORTH — a few stats per model file
      const fromTwin = !!twinPath && existsSync(twinPath);
      // loop: NOT-WORTH — one stat per model file
      if (!existsSync(target)) {
        // a crash after the moves below left it in the set's folder already: taken back, and checked again
        // loop: NOT-WORTH — one stat + rename per model file
        if (f.file !== "models.json" && existsSync(join(p.models, f.file))) renameSync(join(p.models, f.file), target);
        else if (fromTwin) {
          deps.progress(done(), need.bytes, `Copying ${f.file} from the CorridorKey models`);
          // loop: NOT-WORTH — one local copy (a reflink where the file system has them) [bounded: 1.7 GB]
          copyFileSync(twinPath!, target, constants.COPYFILE_FICLONE);
        }
      }
      await fetchOne(f, fromTwin ? `Checking ${f.file}` : `Downloading the TensorRT models (${f.file})`, target, !fromTwin);
    }
    // loop: NOT-WORTH — sixteen local renames, once per install
    for (const f of c.trtModels.files) if (f.file !== "models.json") renameSync(join(partial, f.file), join(p.models, f.file));
    // the set's models.json gains the TensorRT keys; the TensorRT list is written last (the mark that all is in place)
    const merged = { ...readJson(join(p.models, "models.json")), ...readJson(join(partial, "models.json")) };
    writeAtomic(join(p.models, "models.json"), JSON.stringify(merged, null, 2) + "\n");
    // loop: NOT-WORTH — one rename: the TensorRT models count as installed from here
    renameSync(join(partial, "models.json"), p.list);
    // loop: NOT-WORTH — removes the emptied partial folder
    rmSync(partial, { recursive: true, force: true });
  }
  // loop: NOT-WORTH — one readdir of the (now empty) downloads folder
  if (readdirSync(downloads).length === 0) rmSync(downloads, { recursive: true, force: true });
}

/**
 * Remove the TensorRT parts (App settings, Storage): the libraries and their licence, the TensorRT model files and
 * their models.json keys. The 1 MB provider stays with the runtime it came with.
 */
export function removeTensorrt(data: string, c: TrtCatalog = TRT_CATALOG): void {
  const p = trtPaths(data, c);
  let keys: string[] = [];
  try {
    keys = Object.keys(readJson(p.list));
  } catch {
    // error: NOT-WORTH — no list (a half install): the TensorRT keys are found by name below
  }
  // the mark first: from here on the parts count as not installed
  // loop: NOT-WORTH — one local unlink per user click
  rmSync(p.list, { force: true });
  const modelsJson = join(p.models, "models.json");
  // loop: NOT-WORTH — one stat per user click
  if (existsSync(modelsJson)) {
    // loop: NOT-WORTH — a few keys
    const left = Object.fromEntries(Object.entries(readJson(modelsJson)).filter(([k]) => !keys.includes(k) && !k.startsWith("tensorrt-")));
    writeAtomic(modelsJson, JSON.stringify(left, null, 2) + "\n");
  }
  // loop: NOT-WORTH — sixteen local unlinks per user click
  for (const f of c.trtModels.files) if (f.file !== "models.json") rmSync(join(p.models, f.file), { force: true });
  // loop: NOT-WORTH — removes a stopped install's folder, per user click
  rmSync(join(data, MODELS_DIR, `.partial-${c.trtModels.name}`), { recursive: true, force: true });
  // loop: NOT-WORTH — removes the libraries folder (a few dozen files), per user click
  rmSync(p.libs, { recursive: true, force: true });
  // loop: NOT-WORTH — as above, a stopped unpack
  rmSync(join(p.runtime, `.partial-${TRT_LIBS_DIR}`), { recursive: true, force: true });
  // loop: NOT-WORTH — the runtime folder's few entries, per user click
  if (existsSync(p.runtime)) for (const d of readdirSync(p.runtime).filter((n) => TRT_DIST_INFO.test(n))) rmSync(join(p.runtime, d), { recursive: true, force: true });
}
