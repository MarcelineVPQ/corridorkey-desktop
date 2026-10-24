// First-run install (BACKLOG row 2): the GPU runtime and the models, downloaded into the data folder
// (engineFind.ts dataDir) where the Engine page's lists find them. Nothing is hosted for the runtime:
// ONNX Runtime and NVIDIA's CUDA / cuDNN libraries come from PyPI as published wheels, pinned here by
// URL, size and SHA-256. The models come from this repository's `models-2.0.0-onnx.3` release
// (converted from Corridor Digital's checkpoint; CorridorKey licence). Every file is checked before use.
// After a Stop or a failure, pressing the button again resumes: finished files are checked offline and kept,
// a partial one continues where it stopped. A set only appears in the lists once all of it is in place
// (built in a `.partial-…` folder, then renamed; engineFind skips dot folders).
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statfsSync } from "node:fs";
import { join } from "node:path";
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
    };
  }
  // loop: NOT-WORTH — one stat of the NVIDIA driver's file per check
  const ok = platform === "win32" ? exists(join(env.SystemRoot || "C:\\Windows", "System32", "nvml.dll")) : exists("/proc/driver/nvidia/version");
  return { ok, problem: ok ? null : "No NVIDIA graphics driver is loaded. CorridorKey Desktop runs on NVIDIA graphics cards.", runtime: NVIDIA_RUNTIME };
}

/** What to keep from a wheel: ONNX Runtime's libraries, NVIDIA's libraries, and every licence file. */
export function keepFromWheel(name: string): boolean {
  if (/^onnxruntime\/capi\/libonnxruntime(\.so\.|_providers_(cuda|shared)\.so$)/.test(name)) return true;
  // Windows: the DLLs (the TensorRT provider stays out, as on Linux)
  if (/^onnxruntime\/capi\/onnxruntime(_providers_(cuda|shared))?\.dll$/.test(name)) return true;
  if (/^nvidia\/[^/]+\/bin\/(x86_64\/)?[^/]+\.dll$/.test(name)) return true;
  // the package's metadata: the Engine page reads ONNX Runtime's version from its dist-info folder on Windows
  if (/^onnxruntime(_gpu)?-[\d.]+\.dist-info\/METADATA$/.test(name)) return true;
  if (/^nvidia\/[^/]+\/lib\/[^/]+\.so[.\d]*$/.test(name)) return true;
  // macOS: libonnxruntime.1.31.0.dylib
  if (/^onnxruntime\/capi\/libonnxruntime\.[\d.]+\.dylib$/.test(name)) return true;
  // ONNX Runtime's own licence and third-party notices (the macOS wheel keeps them in the package folder)
  if (/^onnxruntime\/(LICENSE|ThirdPartyNotices\.txt)$/.test(name)) return true;
  return /\.dist-info\/(licenses\/.+|LICENSE[^/]*)$/i.test(name);
}

const RELEASE = "https://github.com/MarcelineVPQ/corridorkey-desktop/releases/download/models-2.0.0-onnx.3";
const model = (file: string, size: number, sha256: string): Download => ({ file, url: `${RELEASE}/${file}`, size, sha256 });
export const MODELS = {
  name: "2.0.0-onnx.3",
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
export const RUNTIME_BYTES = total(runtimeFor(process.platform).wheels);
export const MODELS_BYTES = total(MODELS.files);

/** What gets installed: the pinned runtime and model set (tests pass a small one). */
export interface Catalog {
  runtime: { name: string; wheels: Download[] };
  models: { name: string; files: Download[] };
}
const CATALOG: Catalog = { runtime: runtimeFor(process.platform), models: MODELS };

/** What is still to install: each set is there once its folder is (the rename is the last step). */
export function installNeeds(data: string, exists: (p: string) => boolean = existsSync, c: Catalog = CATALOG): { runtime: boolean; models: boolean; bytes: number } {
  const runtime = !exists(join(data, "runtime", c.runtime.name));
  const models = !exists(join(data, "models", c.models.name));
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
  if (room !== null && room < needRoom) throw new Error(`not enough free disk space: it needs ${(needRoom / 1e9).toFixed(1)} GB in ${data}, ${(room / 1e9).toFixed(1)} GB is free`);
  const downloads = join(data, "downloads");
  // loop: NOT-WORTH — one mkdir per install
  mkdirSync(downloads, { recursive: true });
  let done = 0;
  // a model file downloads straight into the set's .partial folder, so a stopped install keeps the checked ones
  const fetchOne = async (d: Download, step: string, path = join(downloads, d.file)) => {
    // loop: SERIAL-REQUIRED — one file at a time: the line is the limit, and progress stays one honest number
    await downloadVerified(deps.fetch, { url: d.url, size: d.size, sha256: d.sha256, source: "the app's list" }, path, (got) => deps.progress(done + got, need.bytes, step), deps.abort, undefined, {
      resume: true,
    });
    done += d.size;
  };

  if (need.runtime) {
    const partial = join(data, "runtime", `.partial-${RUNTIME.name}`);
    // loop: NOT-WORTH — clears a half-unpacked runtime once per install
    rmSync(partial, { recursive: true, force: true });
    // loop: SERIAL-REQUIRED — one wheel at a time (download, then unpack), see fetchOne
    for (const w of RUNTIME.wheels) {
      const label = w.label ?? w.file;
      await fetchOne(w, `Downloading ${label}`);
      deps.progress(done, need.bytes, `Unpacking ${label}`);
      // loop: SERIAL-REQUIRED — unpacks one wheel [bounded: its size]
      const unpacked = await unzip(join(downloads, w.file), partial, keepFromWheel, deps.abort);
      // licence files alone don't count: a wheel must give at least one library
      // loop: NOT-WORTH — the few names one wheel unpacked
      if (!unpacked.some((n) => /\.(so[.\d]*|dll)$/.test(n))) throw new Error(`${w.file} had none of the expected libraries`);
    }
    // loop: NOT-WORTH — one rename: the runtime appears whole
    renameSync(partial, join(data, "runtime", RUNTIME.name));
  }
  // the wheels once the runtime is in place (also after a crash between the rename and this cleanup)
  // loop: NOT-WORTH — eight local unlinks, once per install
  if (existsSync(join(data, "runtime", RUNTIME.name))) for (const w of RUNTIME.wheels) rmSync(join(downloads, w.file), { force: true });

  if (need.models) {
    const partial = join(data, "models", `.partial-${MODELS.name}`);
    // loop: NOT-WORTH — one mkdir per install
    mkdirSync(partial, { recursive: true });
    // loop: SERIAL-REQUIRED — one file at a time, see fetchOne
    // (a file already there from a stopped install is checked offline and kept: downloadVerified's resume)
    for (const f of MODELS.files) await fetchOne(f, `Downloading the CorridorKey models (${f.file})`, join(partial, f.file));
    // loop: NOT-WORTH — one rename: the model set appears whole
    renameSync(partial, join(data, "models", MODELS.name));
  }
  // loop: NOT-WORTH — one readdir of the (now empty) downloads folder
  if (readdirSync(downloads).length === 0) rmSync(downloads, { recursive: true, force: true });
}
