// First-run install (BACKLOG row 2): the GPU runtime and the models, downloaded into the data folder
// (engineFind.ts dataDir) where the Engine page's lists find them. Nothing is hosted for the runtime:
// ONNX Runtime and NVIDIA's CUDA / cuDNN libraries come from PyPI as published wheels, pinned here by
// URL, size and SHA-256. The models come from this repository's `models-2.0.0-onnx.3` release
// (converted from Corridor Digital's checkpoint; CorridorKey licence). Every file is checked before use.
// Downloads resume after a stop or a lost connection; a set only appears in the lists once all of it is in
// place (built in a `.partial-…` folder, then renamed).
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { downloadVerified, type FetchFn } from "./download";
import { unzip } from "./unzip";

export interface Download {
  file: string;
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
      file: "onnxruntime_gpu-1.31.0-cp312-cp312-manylinux_2_28_x86_64.whl",
      url: `${PYPI}/8f/48/6fbfdbce25e5756c7b9ff8f40645d98b166b8022cf00ede58a2bb4571b8e/onnxruntime_gpu-1.31.0-cp312-cp312-manylinux_2_28_x86_64.whl`,
      size: 255569162,
      sha256: "b52998a075de27ff30e46a125001822541fa5b03f5d31398ab0e50789d80c51c",
    },
    {
      file: "nvidia_cublas-13.8.1.7-py3-none-manylinux_2_27_x86_64.whl",
      url: `${PYPI}/eb/1b/adc70acf3fde509b1f0ca29d1c0e8d9b00aaecd871f8cf877257c8b68d9c/nvidia_cublas-13.8.1.7-py3-none-manylinux_2_27_x86_64.whl`,
      size: 439315821,
      sha256: "c11a27fd4379510e5b1f84b367a2514d1e52fe5cc13442117a0e0a1addee3cf2",
    },
    {
      file: "nvidia_cuda_nvrtc-13.4.92-py3-none-manylinux2010_x86_64.manylinux_2_12_x86_64.whl",
      url: `${PYPI}/56/9c/1342ebb460ce2afd014ec5a002adc99108e3c53a6b70f399cf64dd1f267d/nvidia_cuda_nvrtc-13.4.92-py3-none-manylinux2010_x86_64.manylinux_2_12_x86_64.whl`,
      size: 53301733,
      sha256: "5ce8c97b00b232c4f50c8c4b5a3b68cafee08bdb82ea86f2052ff01d03194f4a",
    },
    {
      file: "nvidia_cuda_runtime-13.4.92-py3-none-manylinux2014_x86_64.manylinux_2_17_x86_64.whl",
      url: `${PYPI}/98/8a/3431271f6344874b8f1ac03f16b3d679c91493f8da63f716160403e6d0a0/nvidia_cuda_runtime-13.4.92-py3-none-manylinux2014_x86_64.manylinux_2_17_x86_64.whl`,
      size: 2494438,
      sha256: "9641f797da20ce1dd8e779b6e96d08cf9ba564cec8e8225458811ee26423f3a5",
    },
    {
      file: "nvidia_cudnn_cu13-9.27.0.42-py3-none-manylinux_2_27_x86_64.whl",
      url: `${PYPI}/af/75/96ea5c5368eb595c39d629cde08a66227a864e71ccb0e593add2612bb952/nvidia_cudnn_cu13-9.27.0.42-py3-none-manylinux_2_27_x86_64.whl`,
      size: 536771498,
      sha256: "9677e76f21862eb5da7ee5ed69d544738b2d8b5c3ce7e5ec125c5592e6cdbdc8",
    },
    {
      file: "nvidia_cufft-12.4.0.43-py3-none-manylinux2014_x86_64.manylinux_2_17_x86_64.whl",
      url: `${PYPI}/76/bf/3fea3d1c6262bded26ae00e3106432d63235954965d7785f5051ac146651/nvidia_cufft-12.4.0.43-py3-none-manylinux2014_x86_64.manylinux_2_17_x86_64.whl`,
      size: 161750089,
      sha256: "0e8385013596b112d29c9ce8c63dc575b308d77636c7169104e18714f03961a8",
    },
    {
      file: "nvidia_curand-10.4.4.72-py3-none-manylinux_2_27_x86_64.whl",
      url: `${PYPI}/07/73/3ee8e5b4cb891401e603ffd3a59b35c6afe785fd2de123afe7c7029603dc/nvidia_curand-10.4.4.72-py3-none-manylinux_2_27_x86_64.whl`,
      size: 61498332,
      sha256: "25c3457ae7a224fdd484dab90b0fc5dc0e842fab5db3012afa4a5bd2af4eb7e5",
    },
    {
      file: "nvidia_nvjitlink-13.4.92-py3-none-manylinux2010_x86_64.manylinux_2_12_x86_64.whl",
      url: `${PYPI}/1d/6b/eef7a9e32872b8f41e145bf10cddc9af26e153c338852811fe9a9baddf9e/nvidia_nvjitlink-13.4.92-py3-none-manylinux2010_x86_64.manylinux_2_12_x86_64.whl`,
      size: 42452378,
      sha256: "e0391f24ed94ec879b84e3da4d4ec320c879aff681f2c7a638462f7199284323",
    },
  ] as Download[],
};

/** What to keep from a wheel: ONNX Runtime's libraries, NVIDIA's libraries, and every licence file. */
export function keepFromWheel(name: string): boolean {
  if (/^onnxruntime\/capi\/libonnxruntime(\.so\.|_providers_(cuda|shared)\.so$)/.test(name)) return true;
  if (/^nvidia\/[^/]+\/lib\/[^/]+\.so[.\d]*$/.test(name)) return true;
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
export const RUNTIME_BYTES = total(RUNTIME.wheels);
export const MODELS_BYTES = total(MODELS.files);

/** What is still to install: each set is there once its folder is (the rename is the last step). */
export function installNeeds(data: string, exists: (p: string) => boolean = existsSync): { runtime: boolean; models: boolean; bytes: number } {
  const runtime = !exists(join(data, "runtime", RUNTIME.name));
  const models = !exists(join(data, "models", MODELS.name));
  return { runtime, models, bytes: (runtime ? RUNTIME_BYTES : 0) + (models ? MODELS_BYTES : 0) };
}

export interface InstallDeps {
  fetch: FetchFn;
  // bytes done of the whole install, and what is happening ("Downloading cuDNN…")
  progress: (done: number, total: number, step: string) => void;
  abort: AbortSignal;
}

/** Download and unpack whatever is missing. Resumable: run it again after a stop or a failure. */
// loop: NOT-WORTH — a few rmSync / mkdir / rename calls per install (local disk)
export async function runInstall(data: string, deps: InstallDeps): Promise<void> {
  const need = installNeeds(data);
  const downloads = join(data, "downloads");
  // loop: NOT-WORTH — one mkdir per install
  mkdirSync(downloads, { recursive: true });
  let done = 0;
  const fetchOne = async (d: Download, step: string) => {
    // loop: SERIAL-REQUIRED — one file at a time: the line is the limit, and progress stays one honest number
    await downloadVerified(
      deps.fetch,
      { url: d.url, size: d.size, sha256: d.sha256, source: "the app's list" },
      join(downloads, d.file),
      (got) => deps.progress(done + got, need.bytes, step),
      deps.abort,
      undefined,
      { resume: true },
    );
    done += d.size;
  };

  if (need.runtime) {
    const partial = join(data, "runtime", `.partial-${RUNTIME.name}`);
    // loop: NOT-WORTH — clears a half-unpacked runtime once per install
    rmSync(partial, { recursive: true, force: true });
    // loop: SERIAL-REQUIRED — one wheel at a time (download, then unpack), see fetchOne
    for (const w of RUNTIME.wheels) {
      const label = w.file.startsWith("onnxruntime")
        ? "ONNX Runtime"
        : `NVIDIA ${w.file
            .split("-")[0]
            .replace(/^nvidia_/, "")
            .replace(/_cu13$/, "")}`;
      await fetchOne(w, `Downloading ${label}`);
      deps.progress(done, need.bytes, `Unpacking ${label}`);
      // loop: SERIAL-REQUIRED — unpacks one wheel [bounded: its size]
      if ((await unzip(join(downloads, w.file), partial, keepFromWheel, deps.abort)) === 0) throw new Error(`${w.file} had none of the expected libraries`);
    }
    // loop: NOT-WORTH — one rename: the runtime appears whole
    renameSync(partial, join(data, "runtime", RUNTIME.name));
    // loop: SERIAL-REQUIRED — removes the wheels once unpacked (one at a time, local unlinks)
    for (const w of RUNTIME.wheels) rmSync(join(downloads, w.file), { force: true });
  }

  if (need.models) {
    const partial = join(data, "models", `.partial-${MODELS.name}`);
    // loop: NOT-WORTH — one mkdir per install
    mkdirSync(partial, { recursive: true });
    // loop: SERIAL-REQUIRED — one file at a time, see fetchOne
    for (const f of MODELS.files) {
      await fetchOne(f, `Downloading the CorridorKey models (${f.file})`);
      // loop: NOT-WORTH — one rename per checked model file
      renameSync(join(downloads, f.file), join(partial, f.file));
    }
    // loop: NOT-WORTH — one rename: the model set appears whole
    renameSync(partial, join(data, "models", MODELS.name));
  }
  // loop: NOT-WORTH — one readdir of the (now empty) downloads folder
  if (readdirSync(downloads).length === 0) rmSync(downloads, { recursive: true, force: true });
}
