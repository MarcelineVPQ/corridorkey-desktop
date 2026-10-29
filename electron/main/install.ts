// First-run install (BACKLOG row 2): the GPU runtime and the models, downloaded into the data folder
// (engineFind.ts dataDir) where the Engine page's lists find them. Nothing is hosted for the runtime:
// ONNX Runtime and NVIDIA's CUDA / cuDNN libraries come from PyPI as published wheels, pinned here by
// URL, size and SHA-256. The models come from this repository's `models-2.0.0-onnx.5` release on every system (macOS
// adds its Core ML set, `models-2.0.0-onnx.5-coreml.1` (1280×1080, 1920×1080 and 4K), below; Linux and Windows users may
// choose `2.0.0-onnx.4` instead in Engine settings, backlog row 168) (converted from Corridor Digital's checkpoint; CorridorKey licence). Every file is
// checked before use. AMD cards on Linux, behind the CK_AMD switch (amd.ts; off by default, untested on a real AMD
// card): ONNX Runtime with AMD's ROCm 10.1 and MIGraphX wheels from repo.amd.com, and MIGraphX's MoGe and stage 2
// from `models-2.0.0-onnx.5-trt` (RUNTIME_AMD, MIGRAPHX below).
// After a Stop or a failure, pressing the button again resumes: finished files are checked offline and kept,
// a partial one continues where it stopped. A set only appears in the lists once all of it is in place
// (built in a `.partial-…` folder, then renamed; engineFind skips dot folders).
import { gbBytes } from "../../src/shared/units";
import type { ModelSetChoice } from "../../src/shared/types";
import { lowerFirst, INSTALL_FIRST } from "../../src/shared/texts";
import { DOWNLOADS_DIR, LIBRARY_FILE, MODELS_DIR, PLATFORM, RUNTIME_DIR } from "./platform";
import { REPO } from "./updateFeed";
import { constants, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statfsSync, statSync, writeFileSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { amdSwitchOn, findAmdCard, type AmdCard } from "./amd";
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

// Linux with an AMD card, behind the CK_AMD switch (amd.ts; docs/AMD.md; untested on a real AMD card): the plain
// onnxruntime wheel (the provider is a plugin, so no GPU build) with AMD's MIGraphX provider plugin, MIGraphX and
// ROCm 10.1's pip packages from AMD's repository, plus one device wheel for the card (ROCM_DEVICE). Unpacked in pip's
// layout: the libraries find each other through $ORIGIN-relative RPATHs, and the engine finds the plugin next to
// ONNX Runtime's package (runtime.rs migraphx_lib). Sizes and SHA-256 checked 2026-10-28 (two downloads each).
const AMD_REPO = "https://stable.repo.amd.com/rocm";
export const RUNTIME_AMD = {
  name: "ort-1.31.0-rocm10.1",
  wheels: [
    {
      label: "ONNX Runtime",
      file: "onnxruntime-1.31.0-cp312-cp312-manylinux_2_28_x86_64.whl",
      url: `${PYPI}/6c/44/1e9e762b95b7da0a8424913a1ed7c38cdaf88624a3c41ddba24ebac88bc9/onnxruntime-1.31.0-cp312-cp312-manylinux_2_28_x86_64.whl`,
      size: 23760984,
      sha256: "5e129d6c56abd53e659cb70f00a108d6824086470ff99c2e47a82e5786563db3",
    },
    {
      label: "AMD's MIGraphX provider for ONNX Runtime",
      file: "onnxruntime_ep_migraphx-1.0.0+rocm10.1.0-cp312-cp312-manylinux_2_28_x86_64.whl",
      url: `${AMD_REPO}/onnxruntime/whl-next/onnxruntime-ep-migraphx/onnxruntime_ep_migraphx-1.0.0%2Brocm10.1.0-cp312-cp312-manylinux_2_28_x86_64.whl`,
      size: 1808763,
      sha256: "f43aafe7581fc7f82f94518424c86418371cdcc31c2cb399cec14e7d5c8cd19c",
    },
    {
      label: "AMD MIGraphX",
      file: "migraphx_libs-2.18.0+rocm10.1.0-py3-none-manylinux_2_28_x86_64.whl",
      url: `${AMD_REPO}/migraphx/whl-next/migraphx-libs/migraphx_libs-2.18.0%2Brocm10.1.0-py3-none-manylinux_2_28_x86_64.whl`,
      size: 82963723,
      sha256: "0a625d0fc835db4727af8b6199a0a85bcaa0578cc2a873f6fbbe36b70d84713b",
    },
    {
      label: "AMD ROCm (core)",
      file: "rocm_sdk_core-10.1.0-py3-none-linux_x86_64.whl",
      url: `${AMD_REPO}/core/whl-next/rocm-sdk-core/rocm_sdk_core-10.1.0-py3-none-linux_x86_64.whl`,
      size: 419364838,
      sha256: "a1a2433334ac61a526c6bae2f58f6bbc9b525f5a9e008e76a1a48d07f64f0703",
    },
    {
      label: "AMD ROCm (libraries)",
      file: "rocm_sdk_libraries-10.1.0-py3-none-linux_x86_64.whl",
      url: `${AMD_REPO}/core/whl-next/rocm-sdk-libraries/rocm_sdk_libraries-10.1.0-py3-none-linux_x86_64.whl`,
      size: 260814462,
      sha256: "ffb36d5e1d97e96c191052a10c39a1a7a4ddb4da4a88d3166ab4bf7bfdb94cf6",
    },
  ] as Download[],
};
const rocmDevice = (gfx: string, size: number, sha256: string): Download => ({
  label: `AMD ROCm (${gfx} kernels)`,
  file: `rocm_sdk_device_${gfx}-10.1.0-py3-none-linux_x86_64.whl`,
  url: `${AMD_REPO}/core/whl-next/rocm-sdk-device-${gfx}/rocm_sdk_device_${gfx}-10.1.0-py3-none-linux_x86_64.whl`,
  size,
  sha256,
});
/**
 * ROCm 10.1's device wheel per card: the targets AMD's ONNX Runtime page lists for MIGraphX (Radeon RX 7000:
 * gfx1100-1102; RX 9000 and AI PRO R9700: gfx1200/1201; Ryzen AI graphics: gfx1150-1153; Instinct MI200/MI300/MI350:
 * gfx90a, gfx942, gfx950). Another AMD card is refused with a reason (systemSupport), never run on the CPU.
 */
export const ROCM_DEVICE: Record<string, Download> = {
  gfx1100: rocmDevice("gfx1100", 233374792, "55fc9d7505c78178060d11bc8dc44b52b3e715f319bd61dd7e7f37c5bec2a94d"),
  gfx1101: rocmDevice("gfx1101", 227269260, "518834a7706da3f448a780d6ec0f96c2d3b4246b6e2b7cc503a5ee219c786b13"),
  gfx1102: rocmDevice("gfx1102", 225388997, "c621497b31bba1551f725e9ae0d39406355163852a56add2e5c73ce9ea295abe"),
  gfx1150: rocmDevice("gfx1150", 155303000, "aee780f79922bc2cc21803ef6fe528b1882523fcc4a27bde5d389df09b9b7529"),
  gfx1151: rocmDevice("gfx1151", 177774184, "e4e4d9b9a5020d0b971aec956f024514ced3ba80857aad7c42ef57bee9ebba5f"),
  gfx1152: rocmDevice("gfx1152", 155150763, "e070fe1682572d32f60afca8220329636929a6c1d3c2638266a06be449fd20fb"),
  gfx1153: rocmDevice("gfx1153", 155302956, "5ee81c972a4314a8c8ba0e492dfe0f4a7bd760dc20515d535b7bd7df5a696b1c"),
  gfx1200: rocmDevice("gfx1200", 405199317, "60433865c41a1a0cf25f1ecf850b8109c11385d8fdb16b229efbc314f77906b1"),
  gfx1201: rocmDevice("gfx1201", 343467033, "78e4360ff25872598563acf4bccaab2360e9f837601c74cf273640ad395cbe01"),
  gfx90a: rocmDevice("gfx90a", 473990744, "3431dc66149ec4e4034c519ac47e3b1c03554a93419a96f45d19b7cde1275419"),
  gfx942: rocmDevice("gfx942", 1832820487, "b755b4f472384eabbcc7603edd1d81c1164d220fb64d7e96bae5f44736418461"),
  gfx950: rocmDevice("gfx950", 703085527, "3009a3cc877beff557b29282e20f379588666861807b78137c5484c40c14b020"),
};
/** The AMD runtime for a card ROCm 10.1 supports, else null. */
export function amdRuntime(gfx: string | null): { name: string; wheels: Download[]; gfx: string } | null {
  const device = gfx ? ROCM_DEVICE[gfx] : undefined;
  return gfx && device ? { name: `${RUNTIME_AMD.name}-${gfx}`, wheels: [...RUNTIME_AMD.wheels, device], gfx } : null;
}

/** The runtime this system downloads (`gfx`: the AMD card amdCardFor found, null on every other setup). */
export function runtimeFor(platform: NodeJS.Platform, gfx: string | null = null): Catalog["runtime"] {
  if (platform === "linux") return amdRuntime(gfx) ?? RUNTIME;
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
const NVIDIA_DRIVER = "/proc/driver/nvidia/version";
export const AMD_RUNTIME =
  "ONNX Runtime (Microsoft, MIT licence) and AMD's ROCm 10.1 and MIGraphX libraries (AMD; MIT and others, in the app's third-party notices), from pypi.org and repo.amd.com. AMD cards are new here: not yet tested on a real AMD card";

/**
 * The AMD card the setup installs for (Linux, the CK_AMD switch on, no NVIDIA driver loaded: NVIDIA comes first, as
 * the engine's `auto` does). Null on every other setup, without reading the system.
 */
export function amdCardFor(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, exists: (p: string) => boolean, find: () => AmdCard | null = findAmdCard): AmdCard | null {
  // loop: NOT-WORTH — one stat of the NVIDIA driver's file, once per app start
  if (platform !== "linux" || !amdSwitchOn(env) || exists(NVIDIA_DRIVER)) return null;
  return find();
}

/** The AMD side of systemSupport: the card ROCm 10.1 supports and this user may open, else why not. */
function amdSupport(amd: AmdCard | null): SystemSupport {
  const short = "ONNX Runtime, ROCm, MIGraphX";
  if (!amd)
    return {
      ok: false,
      problem: "No NVIDIA graphics driver is loaded and no AMD graphics card was found (no ROCm KFD device). CorridorKey Desktop runs on NVIDIA graphics cards, and on AMD cards ROCm 10.1 supports.",
      runtime: AMD_RUNTIME,
      runtimeShort: short,
    };
  if (!ROCM_DEVICE[amd.gfx])
    return {
      ok: false,
      problem: `This AMD graphics card (${amd.gfx}) isn't one ROCm 10.1's MIGraphX supports: Radeon RX 7000 and RX 9000, Radeon AI PRO R9700, Ryzen AI graphics and Instinct MI200, MI300 and MI350 cards are.`,
      runtime: AMD_RUNTIME,
      runtimeShort: short,
    };
  if (!amd.access)
    return {
      ok: false,
      problem: `This AMD graphics card (${amd.gfx}) can't be opened by your user: add yourself to the render and video groups (sudo usermod -aG render,video $USER), then log out and back in.`,
      runtime: AMD_RUNTIME,
      runtimeShort: short,
    };
  return { ok: true, problem: null, runtime: AMD_RUNTIME, runtimeShort: short };
}

/**
 * Linux: the NVIDIA driver's proc file (with the CK_AMD switch on and no NVIDIA driver: the AMD card, `amd` from
 * amdCardFor); Windows: its NVML library in System32; macOS: Apple Silicon (Core ML runs on its GPU and Neural
 * Engine; there is no Intel Mac build).
 */
export function systemSupport(platform: NodeJS.Platform, arch: string, exists: (p: string) => boolean, env: NodeJS.ProcessEnv, amd: AmdCard | null = null): SystemSupport {
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
  const ok = platform === "win32" ? exists(join(env.SystemRoot || "C:\\Windows", "System32", "nvml.dll")) : exists(NVIDIA_DRIVER);
  if (!ok && platform === "linux" && amdSwitchOn(env)) return amdSupport(amd);
  return { ok, problem: ok ? null : "No NVIDIA graphics driver is loaded. CorridorKey Desktop runs on NVIDIA graphics cards.", runtime: NVIDIA_RUNTIME, runtimeShort: "ONNX Runtime, CUDA, cuDNN" };
}

/**
 * What to keep from a wheel: ONNX Runtime's libraries, NVIDIA's libraries (AMD's with the CK_AMD switch), and every
 * licence file. `gfx`: an AMD runtime's card, whose MIGraphX kernels alone are kept (each target's are in the wheel).
 */
export function keepFromWheel(name: string, gfx?: string): boolean {
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
  // Linux AMD (RUNTIME_AMD): what loading AMD's MIGraphX plugin needs (its ELF dependencies, read with ldd from the
  // unpacked wheels 2026-10-28), what HIP's runtime compiler reads (LLVM's device bitcode and clang headers), and every
  // device wheel's kernels and databases; the debugger, profilers, Python bindings, compilers' programs and the
  // ROCm libraries MIGraphX doesn't link (rocsparse, rocfft, rpp, ...) stay out. A first cut, to confirm on a real card.
  if (name === "onnxruntime_ep_migraphx/libmigraphx-ep.so") return true;
  if (/^migraphx_libs\/libmigraphx(_c|_onnx|_tf|_gpu|_device)?\.so\.[^/]+$/.test(name)) return !gfx || !/--gfx\w+$/.test(name) || name.endsWith(`--${gfx}`);
  if (/^_rocm_sdk_core\/lib\/lib(amdhip64|amd_comgr|hiprtc|hiprtc-builtins|hsa-runtime64|rocprofiler-register|rocm_kpack|roctx64)\.so\.\d+$/.test(name)) return true;
  if (/^_rocm_sdk_core\/lib\/rocm_sysdeps\/lib\/librocm_sysdeps_(bz2|drm|drm_amdgpu|elf|liblzma|numa|sqlite3|z|zstd)\.so[.\d]*$/.test(name)) return true;
  if (/^_rocm_sdk_core\/lib\/llvm\/(lib\/lib(LLVM|clang-cpp)\.so\.[^/]+|amdgcn\/bitcode\/[^/]+\.bc|lib\/clang\/\d+\/include\/.+)$/.test(name)) return true;
  if (/^_rocm_sdk_libraries\/lib\/lib(MIOpen|rocblas|hipblaslt|rocroller|origami)\.so\.\d+$/.test(name)) return true;
  if (/^_rocm_sdk_libraries\/(lib\/libMIOpenCKGroupedConv_gfx[0-9a-f]+\.so|lib\/(rocblas|hipblaslt)\/.+|share\/miopen\/.+|\.kpack\/.+|\.devel_links\/.+)$/.test(name)) return true;
  // the ROCm licence texts the core wheel has (the others carry none: THIRD_PARTY_NOTICES.md has them, licenses/rocm)
  if (/^_rocm_sdk_core\/share\/doc\/[^/]+\/(LICENSE|License)[^/]*$/.test(name)) return true;
  // ONNX Runtime's own licence and third-party notices (the macOS wheel keeps them in the package folder)
  if (/^onnxruntime\/(LICENSE|ThirdPartyNotices\.txt)$/.test(name)) return true;
  return /\.dist-info\/(licenses\/.+|LICENSE[^/]*)$/i.test(name);
}

// the model set, and this repository's release that holds it (models-<set>)
const MODEL_SET = "2.0.0-onnx.5";
const release = (set: string) => `https://github.com/${REPO}/releases/download/models-${set}`;
const inRelease =
  (set: string) =>
  (file: string, size: number, sha256: string): Download => ({ file, url: `${release(set)}/${file}`, size, sha256 });
const model = inRelease(MODEL_SET);
/** The fp16 set (BACKLOG row 165), on every system. */
export const MODELS_CUDA = {
  name: MODEL_SET,
  files: [
    model("ck2-cradio-fp16.onnx", 690471, "cdc7b0569edb70a5164b0614aa9c9332a4525a6281b453826430dc46af6a8fe9"),
    model("ck2-cradio-fp16.onnx.data", 900504288, "c5f8a2d73786f4c0308ea349f494c6affdff6e72b94ab746dea3589bcb4f1c9e"),
    model("ck2-moge-fp16.onnx", 425920, "b035a6904fc72f91abae20f31de342cbb6bffc65ed75d33cc4d88d7008de8712"),
    model("ck2-moge-fp16.onnx.data", 177747456, "fefb7ec179377603b5011202244c92176db42782d9281eef9f1ce2eee5294c45"),
    model("ck2-rvm-fp16.onnx", 657354, "cfb8aa3c20ec5a63421cfe480d1792950adde598edcb12b33810827de871a809"),
    model("ck2-rvm-fp16.onnx.data", 66827776, "988b0b97752df9c13c9e78ec7c844faecac35d7ae9eaede6a2c13609c79b9617"),
    model("ck2-stage1-fp16.onnx", 2544426, "f8a7bb9f135cee0ba0591b72ae2168e4e200074a8f3f98a3fc3fa18e1d59df16"),
    model("ck2-stage1-fp16.onnx.data", 924104448, "9807e184faa0f79b2f3b45aa85169e9655aa356e8b4dbc6e67a21dcc22d36b9c"),
    model("ck2-stage2-fp16.onnx", 1133800, "9754495a70b1efcb73bdac9925cc78d37af29e0c07af4ee75747a9ecab69045f"),
    model("ck2-stage2-fp16.onnx.data", 403914240, "1e537c9b14bdf905d931338c5e2e8c83cfd03d5eb29bfeebdd73de51b3236530"),
    model("manifest.json", 16830, "2d4f06a7d3930766e674bf4a7e25e9c091a629860e448c3bde61289ea0b85013"),
    model("models.json", 395, "01f0d8e592d10a9459f72ce23ebfaded0b56168b6d838799a0dad8172fe9ebff"),
  ],
};

// 2.0.0-onnx.4, dev.1's set: downloaded when a user chooses it (Linux and Windows, row 168); an installed copy also
// gives onnx.5's TensorRT set its C-RADIO weights (trtCatalogFor's older)
const OLD_MODEL_SET = "2.0.0-onnx.4";
const oldModel = inRelease(OLD_MODEL_SET);
/** 2.0.0-onnx.4's files. */
export const MODELS_ONNX4 = {
  name: OLD_MODEL_SET,
  files: [
    oldModel("ck2-cradio-fp16.onnx", 789360, "25e8656dffc2c639f1557b092ea5d2738d7c4002b495195f93ba41a3610b0334"),
    oldModel("ck2-cradio-fp16.onnx.data", 1724414688, "8f76c92ddf779b70745fc985820e7e312f7eb07ec82b4e20119062798f952b9f"),
    oldModel("ck2-moge-fp16.onnx", 425920, "b035a6904fc72f91abae20f31de342cbb6bffc65ed75d33cc4d88d7008de8712"),
    oldModel("ck2-moge-fp16.onnx.data", 177747456, "fefb7ec179377603b5011202244c92176db42782d9281eef9f1ce2eee5294c45"),
    oldModel("ck2-rvm-fp16.onnx", 657354, "cfb8aa3c20ec5a63421cfe480d1792950adde598edcb12b33810827de871a809"),
    oldModel("ck2-rvm-fp16.onnx.data", 66827776, "988b0b97752df9c13c9e78ec7c844faecac35d7ae9eaede6a2c13609c79b9617"),
    oldModel("ck2-stage1-fp16.onnx", 2471932, "3c19272c263ec952bc16a02333c6fc3ee8acf71d75fd62fbebcc4e0280ccd10d"),
    oldModel("ck2-stage1-fp16.onnx.data", 924102400, "d354507432f0635409ea08ec2abdd10fb04539070ce8eac7b815f58ff5e32431"),
    oldModel("ck2-stage2-fp16.onnx", 1330091, "1c6a5ae09a752b738b9c75bee448b5ec4e82bd1b430192d72d167e5e5166bbfe"),
    oldModel("ck2-stage2-fp16.onnx.data", 403914240, "1e537c9b14bdf905d931338c5e2e8c83cfd03d5eb29bfeebdd73de51b3236530"),
    oldModel("manifest.json", 16779, "56d63e810ed798bbce5060bda555667abafbbdd4b6822ebb77ba94e509e7e7e9"),
    oldModel("models.json", 395, "01f0d8e592d10a9459f72ce23ebfaded0b56168b6d838799a0dad8172fe9ebff"),
  ],
};
// AMD (CK_AMD; docs/AMD.md): MIGraphX 2.18 takes onnx.5's own C-RADIO, RVM and stage 1, and refuses its MoGe
// (antialiased resize) and stage 2 (attention_bias broadcast over the heads): those two come in their TensorRT form
// from onnx.5's TensorRT release. That mix parses at 384×256, 1280×1152, 1920×1152 and 3840×2176 (MIGraphX's own
// parser, offline: tools/migraphx_ops.py, 2026-10-28); never run on a card yet. The files go into the set's own
// MIGRAPHX_DIR folder (no name shared with the TensorRT install's), and models.json gets MIGRAPHX_KEY.
const MIGRAPHX_MODEL_SET = `${MODEL_SET}-trt`;
const mxModel = inRelease(MIGRAPHX_MODEL_SET);
export const MIGRAPHX_DIR = "migraphx";
export const MIGRAPHX = {
  name: MIGRAPHX_MODEL_SET,
  files: [
    mxModel("ck2-moge-trt-fp16.onnx", 425292, "0c94de749d02f1982c26f72f96c5392a0396b6b1c6a27ae2917ffc61776d4eff"),
    mxModel("ck2-moge-trt-fp16.onnx.data", 181014528, "067bcdbfca7cf91d434dc9709451c264eaef747848ac63d5b043912315d59796"),
    mxModel("ck2-stage2-trt-fp16.onnx", 1112602, "dceba38fc853cf93bb35d73d5791b8654d082324efe28519d89e3d9a29b6f006"),
    mxModel("ck2-stage2-trt-fp16.onnx.data", 425429504, "ab6eae0f8c68a5056514f1e4a542a0bdefacc58ba9ef9bd9727f9577e1e38668"),
  ],
};
/** The engine's MIGraphX entry (runtime.rs migraphx_file), merged into the set's models.json. */
export const MIGRAPHX_KEY = {
  "migraphx-fp16": {
    cradio: "ck2-cradio-fp16.onnx",
    moge: `${MIGRAPHX_DIR}/ck2-moge-trt-fp16.onnx`,
    rvm: "ck2-rvm-fp16.onnx",
    stage1: "ck2-stage1-fp16.onnx",
    stage2: `${MIGRAPHX_DIR}/ck2-stage2-trt-fp16.onnx`,
  },
};

/** The default model set (macOS adds its Core ML set). */
export const MODELS = MODELS_CUDA;

/** The model sets a user can choose (Engine settings, ONNX Runtime engine, "Model set"; row 168), the default first. */
export const MODEL_SETS: readonly string[] = [MODEL_SET, OLD_MODEL_SET];
export const DEFAULT_MODEL_SET = MODEL_SET;
const SET_FILES: Record<string, { name: string; files: Download[] }> = { [MODEL_SET]: MODELS_CUDA, [OLD_MODEL_SET]: MODELS_ONNX4 };
/**
 * The sets this system offers: macOS only onnx.5 (Core ML needs its own set, and onnx.4 has none); an AMD card (`gfx`)
 * only onnx.5 too (MIGraphX can't load onnx.4's stage 1 and 2).
 */
export const modelSetsFor = (platform: NodeJS.Platform, gfx: string | null = null): string[] => (platform === "darwin" || (platform === "linux" && amdRuntime(gfx)) ? [MODEL_SET] : [...MODEL_SETS]);
/** The set this system runs for a setting: one it doesn't offer (a settings file from another system) is the default. */
export const chosenModelSet = (setting: string, platform: NodeJS.Platform = PLATFORM, gfx: string | null = null): string => (modelSetsFor(platform, gfx).includes(setting) ? setting : MODEL_SET);

// macOS: the Core ML set (BACKLOG rows 59, 60), fixed-shape copies of the five networks for ONNX Runtime's Core ML provider
// (engine-rs/export/coreml), one file per network and frame size (1280×1080 and 1920×1080 clips, padded 1152×1280 and
// 1152×1920), from release models-<set>-coreml. They keep their weights in the model set's own
// .onnx.data files, so they go into the model set's folder (ONNX Runtime reads external weights only from the model's
// own folder: a symlink fails); the engine finds them through coreml.json, which goes last.
// dev.3 (row 174): 4K added, so a new release name; a Mac with dev.2's set downloads only the new files (installNeeds)
const COREML_SET = `${MODEL_SET}-coreml.1`;
const coremlModel = inRelease(COREML_SET);
export const COREML = {
  name: COREML_SET,
  files: [
    coremlModel("ck2-cradio-fp16-coreml-1152x1280-t4.onnx", 289765413, "af243db4a174056b0f906a622e6c48853d8bc4bba8ec22b7f74caeb56da76b39"),
    coremlModel("ck2-moge-fp16-coreml-1152x1280-t4.onnx", 172035616, "e04b8594da157a56fe2b9c52e0e47077e2773d0e4f7a30bc60ed848d3dc76666"),
    coremlModel("ck2-rvm-fp16-coreml-1152x1280-t1.onnx", 66811967, "c0cedf0b9d11eff3ea156153b6df22834412946f38f0a2a2f5f1a3d9304b1d08"),
    coremlModel("ck2-stage1-fp16-coreml-1152x1280-t4.onnx", 138992655, "a3b37d4342eaa8746bd2f47c841c47b4f95f2589d8448121a4393000980bf91b"),
    coremlModel("ck2-stage1-fp16-coreml-1152x1280-t8.onnx", 144335891, "e4d0e2910f4684a2a82fbb9748d366104fa2e4b94f5cdf54dee23356a3e40d64"),
    coremlModel("ck2-stage2-fp16-coreml-1152x1280-t1.onnx", 305375549, "06467b130bd997fa0e145c49bf4f2ad4c4200bb9d2639ac76ab721b7c885ad29"),
    coremlModel("ck2-cradio-fp16-coreml-1152x1920-t4.onnx", 289765413, "e099acda2cb243e97f380a025f704552b8a5b226f4aeef43f915c4c8d7396870"),
    coremlModel("ck2-moge-fp16-coreml-1152x1920-t4.onnx", 172980576, "8ccdf7f6bcdd33bde510f93e809196b75735d338c12d74f31cfba671592b3d6f"),
    coremlModel("ck2-rvm-fp16-coreml-1152x1920-t1.onnx", 67088447, "76b39dea389e31dd4238cf9db8e186982ba1f008c37a91d8c172d2cfdace7d27"),
    coremlModel("ck2-stage1-fp16-coreml-1152x1920-t4.onnx", 142469139, "4398803f02824e835f895876ce40d2d6ad3d74349c286efe4fe488cb13a77050"),
    coremlModel("ck2-stage1-fp16-coreml-1152x1920-t8.onnx", 150920211, "0bad604eeaaa2426c7322fd4bb3aa8ea5c09bea0be7ff796a88f951acc00c547"),
    coremlModel("ck2-stage2-fp16-coreml-1152x1920-t1.onnx", 317639229, "ae6bdc9c0afcfaa9029f7d30bea9ad7533c3e20f185bfe8de2b5d47d6807777e"),
    // last: the engine finds the set by it, and the install counts it as done once it is there
    coremlModel("ck2-cradio-fp16-coreml-2176x4096-t4.onnx", 289765413, "883db40f101442820c69ab424b4397ce0ba1ff2b268c6ccafcc5dd22334c854a"),
    coremlModel("ck2-moge-fp16-coreml-2176x4096-t4.onnx", 181164324, "ac67867ac8874642911bf6cad7ad483b95b74a7dcf64305a1ce91af37940c8b5"),
    coremlModel("ck2-rvm-fp16-coreml-2176x4096-t1.onnx", 69601345, "d7395d9c9aa0520a4d31cb02b3ed0ffa385150e7572aeb3df5cb8c0ffdabd649"),
    coremlModel("ck2-stage1-fp16-coreml-2176x4096-t4.onnx", 149313600, "59afbf039b6daa032439306849c1bc67d3ac2c80ff16d7920877906cfbf72474"),
    coremlModel("ck2-stage2-fp16-coreml-2176x4096-t1.onnx", 292775146, "6d83947a0e86b6c8386b7e1b2a2b520262e57770c737d9fa7ef5c9c49d302086"),
    coremlModel("coreml.json", 1181, "e7bccacf9f93f543b83812deb7e2c318a797b56d23717e93e4c586c5c9b704a0"),
  ],
};
/** The Core ML set this system downloads with the models (macOS only). */
export const coremlFor = (platform: NodeJS.Platform) => (platform === "darwin" ? COREML : undefined);

// loop: NOT-WORTH — sums a dozen sizes, once per plan
const total = (d: Download[]) => d.reduce((n, x) => n + x.size, 0);
// the install's refusals, the same for the runtime and models and for TensorRT's parts
const noRoom = (need: number, dir: string, free: number) => new Error(`not enough free disk space: it needs ${gbBytes(need)} in ${dir}, ${gbBytes(free)} is free`);
const noLibraries = (file: string) => new Error(`${file} had none of the expected libraries`);
/** The bytes of a download a stopped install already has at `path` (they need no room again; resume keeps them). */
// loop: NOT-WORTH — one stat per planned file, once per install start
const already = (path: string, size: number) => Math.min(size, statSync(path, { throwIfNoEntry: false })?.size ?? 0);

/** What gets installed: the pinned runtime and model set, and on macOS the Core ML set (tests pass a small one). */
export interface Catalog {
  // gfx: an AMD runtime's card (keepFromWheel)
  runtime: { name: string; wheels: Download[]; gfx?: string };
  models: { name: string; files: Download[] };
  coreml?: { name: string; files: Download[] };
  // AMD (CK_AMD): MIGraphX's files, in the model set's MIGRAPHX_DIR folder, and their models.json key
  migraphx?: { name: string; files: Download[] };
}
/** What the setup installs for the chosen model set (`gfx`: the AMD card, amdCardFor; MIGraphX's files then come too). */
export function catalogFor(set: string, platform: NodeJS.Platform = PLATFORM, gfx: string | null = null): Catalog {
  const runtime = runtimeFor(platform, gfx);
  const c: Catalog = { runtime, models: SET_FILES[chosenModelSet(set, platform, gfx)], coreml: coremlFor(platform) };
  return runtime.gfx ? { ...c, migraphx: MIGRAPHX } : c;
}
const CATALOG: Catalog = catalogFor(MODEL_SET);

/** Each set this system offers: installed (its folder is there), or its download (row 168, Engine settings). */
export function modelSetChoices(data: string, platform: NodeJS.Platform = PLATFORM, exists: (p: string) => boolean = existsSync, gfx: string | null = null): ModelSetChoice[] {
  // loop: NOT-WORTH — one or two sets, one stat each, per state refresh after an install or a choice
  return modelSetsFor(platform, gfx).map((name) => {
    const c = catalogFor(name, platform, gfx);
    return { name, installed: exists(join(data, MODELS_DIR, name)), bytes: total(c.models.files) + (c.coreml ? total(c.coreml.files) : 0) + (c.migraphx ? total(c.migraphx.files) : 0) };
  });
}

/**
 * What is still to install: each set is there once its folder is (the rename is the last step); the Core ML set once
 * every pinned file is in the model set's folder (a newer set adds sizes, row 174: a Mac with the older one still
 * needs the new files, and a fresh coreml.json, which replaces the older one).
 */
export function installNeeds(
  data: string,
  exists: (p: string) => boolean = existsSync,
  c: Catalog = CATALOG,
): { runtime: boolean; models: boolean; coreml: boolean; migraphx: boolean; bytes: number } {
  const runtime = !exists(join(data, RUNTIME_DIR, c.runtime.name));
  const models = !exists(join(data, MODELS_DIR, c.models.name));
  // loop: NOT-WORTH — one stat per pinned Core ML file (a few dozen), per setup check
  const cmMissing = c.coreml ? c.coreml.files.filter((f) => f.file === "coreml.json" || !exists(join(data, MODELS_DIR, c.models.name, f.file))) : [];
  // coreml.json alone missing nothing else: only when it isn't there itself
  const coreml = cmMissing.length > 1 || (cmMissing.length === 1 && !exists(join(data, MODELS_DIR, c.models.name, "coreml.json")));
  // AMD: MIGraphX's files are there once their folder is (its rename is their last step)
  // loop: NOT-WORTH — one stat per setup check
  const migraphx = !!c.migraphx && !exists(join(data, MODELS_DIR, c.models.name, MIGRAPHX_DIR));
  return {
    runtime,
    models,
    coreml,
    migraphx,
    bytes: (runtime ? total(c.runtime.wheels) : 0) + (models ? total(c.models.files) : 0) + (coreml ? total(cmMissing) : 0) + (migraphx ? total(c.migraphx!.files) : 0),
  };
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
  const downloads = join(data, DOWNLOADS_DIR);
  // a Core ML file counts in its .partial folder, or in the model set's folder where a stop during the moves left it
  // loop: NOT-WORTH — two stats per Core ML file, once per install start
  // (an older set's coreml.json in the set's folder isn't this one's: it is replaced, never resumed onto)
  const coremlHas = (f: Download) =>
    Math.max(already(join(data, MODELS_DIR, `.partial-${c.coreml!.name}`, f.file), f.size), f.file === "coreml.json" ? 0 : already(join(data, MODELS_DIR, MODELS.name, f.file), f.size));
  // what a stopped install already downloaded is on the disk: only the rest needs room (a resume on a full-ish disk)
  // loop: NOT-WORTH — a dozen planned files, once per install start
  const have =
    (need.runtime ? RUNTIME.wheels.reduce((n, w) => n + already(join(downloads, w.file), w.size), 0) : 0) +
    // loop: NOT-WORTH — as above
    (need.models ? MODELS.files.reduce((n, f) => n + already(join(data, MODELS_DIR, `.partial-${MODELS.name}`, f.file), f.size), 0) : 0) +
    // loop: NOT-WORTH — as above
    (need.coreml && c.coreml ? c.coreml.files.reduce((n, f) => n + coremlHas(f), 0) : 0) +
    // loop: NOT-WORTH — four MIGraphX files, once per install start
    (need.migraphx && c.migraphx ? c.migraphx.files.reduce((n, f) => n + already(join(data, MODELS_DIR, MODELS.name, `.partial-${MIGRAPHX_DIR}`, f.file), f.size), 0) : 0);
  const needRoom =
    (need.runtime ? total(RUNTIME.wheels) * 2.5 : 0) +
    (need.models ? total(MODELS.files) : 0) +
    (need.coreml && c.coreml ? total(c.coreml.files) : 0) +
    (need.migraphx && c.migraphx ? total(c.migraphx.files) : 0) -
    have;
  if (room !== null && room < needRoom) throw noRoom(needRoom, data, room);
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
      const unpacked = await unzip(join(downloads, w.file), partial, (n) => keepFromWheel(n, RUNTIME.gfx), deps.abort);
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
  // macOS: the Core ML set, into the model set's folder (also added to a set installed without it), coreml.json last
  if (need.coreml && c.coreml) {
    const partial = join(data, MODELS_DIR, `.partial-${c.coreml.name}`);
    const set = join(data, MODELS_DIR, MODELS.name);
    // loop: NOT-WORTH — one mkdir per install
    mkdirSync(partial, { recursive: true });
    // loop: SERIAL-REQUIRED — one file at a time, see fetchOne (a file a stopped install finished is checked and kept)
    for (const f of c.coreml.files) {
      const target = join(partial, f.file);
      // in the set's folder already (an older set's file, or a stop during the moves below): taken back and checked
      // again, not downloaded and not counted (installNeeds counts only what is missing); never coreml.json, which an
      // older set's differs from (its bytes would be taken as the start of this one's)
      // loop: NOT-WORTH — two stats per file
      const there = f.file !== "coreml.json" && !existsSync(target) && existsSync(join(set, f.file));
      // loop: NOT-WORTH — one local rename per file already there
      if (there) renameSync(join(set, f.file), target);
      await fetchOne(f, `Downloading the Core ML models (${f.file})`, target, !there);
    }
    // loop: NOT-WORTH — thirteen local renames in the list's order, coreml.json last: the set counts as installed from there
    for (const f of c.coreml.files) renameSync(join(partial, f.file), join(set, f.file));
    // loop: NOT-WORTH — removes the emptied folder
    rmSync(partial, { recursive: true, force: true });
  }
  // AMD: MIGraphX's files into the set's own folder, their key into its models.json, the folder's rename last (the
  // mark that they are in place; a stop before it resumes with the files already checked)
  if (need.migraphx && c.migraphx) {
    const set = join(data, MODELS_DIR, MODELS.name);
    const partial = join(set, `.partial-${MIGRAPHX_DIR}`);
    // loop: NOT-WORTH — one mkdir per install
    mkdirSync(partial, { recursive: true });
    // loop: SERIAL-REQUIRED — one file at a time, see fetchOne
    for (const f of c.migraphx.files) await fetchOne(f, `Downloading MIGraphX's models (${f.file})`, join(partial, f.file));
    const modelsJson = join(set, "models.json");
    writeAtomic(modelsJson, JSON.stringify({ ...readJson(modelsJson), ...MIGRAPHX_KEY }, null, 2) + "\n");
    // loop: NOT-WORTH — one rename: MIGraphX's files count as installed from here
    renameSync(partial, join(set, MIGRAPHX_DIR));
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
//   models: the TensorRT-ready set (release models-<TRT_MODEL_SET>) in the normal set's folder, its models.json keys
//     merged into the set's: the engine finds TensorRT files only through its one --models folder's models.json
//     (engine-rs runtime.rs ModelSet::trt_file / trt_stub). The set's own models.json stays as models-tensorrt.json:
//     the list of what is TensorRT's (Storage removes exactly that) and the mark that the set is whole (written last).
export const TRT_PROVIDER = "libonnxruntime_providers_tensorrt.so";
export const TRT_LIBS_DIR = "tensorrt_libs";
export const TRT_MODELS_LIST = "models-tensorrt.json";
/** The wheel's licence folder, kept next to the libraries. */
export const TRT_DIST_INFO = /^tensorrt_cu\d+_libs-[\d.]+\.dist-info$/;
// dev.1's TensorRT set, kept for dev.2 (Marcy 2026-10-28): onnx.5's own, 2.0.0-onnx.5-trt, isn't measured against it
// yet. Since the model set choice (row 168) it is onnx.4's own TensorRT set, and onnx.5's until onnx.5-trt is measured
// (trtCatalogFor)
const TRT_MODEL_SET = "2.0.0-onnx.4-trt";
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
      // onnx.4's ck2-cradio-fp16.onnx.data bytes (fp32 weights): onnx.5's normal set stores fp16 ones, so this one is
      // downloaded, or copied from an installed 2.0.0-onnx.4 folder (its ck2-cradio-fp16.onnx.data: TRT_CATALOG.older)
      trtModel("ck2-cradio-trt-fp16.onnx.data", 1724414688, "8f76c92ddf779b70745fc985820e7e312f7eb07ec82b4e20119062798f952b9f"),
      trtModel("ck2-moge-trt-fp16-ctx.onnx", 598, "9de6063abe191b1ad7ddac7415a9207f4e95101efdb89e7c2be83a296b2ac313"),
      trtModel("ck2-moge-trt-fp16.onnx", 425292, "0c94de749d02f1982c26f72f96c5392a0396b6b1c6a27ae2917ffc61776d4eff"),
      trtModel("ck2-moge-trt-fp16.onnx.data", 181014528, "067bcdbfca7cf91d434dc9709451c264eaef747848ac63d5b043912315d59796"),
      trtModel("ck2-rvm-trt-fp16-ctx.onnx", 994, "a98773246f4b9c031a483795248ff2f4cd1a1dace4b1be9ede490a2f9d9ae228"),
      trtModel("ck2-rvm-trt-fp16.onnx", 611330, "845019115d9871e1101f6af1f4af5b6378fb3f9c043b453f4aa89369095c9be3"),
      trtModel("ck2-rvm-trt-fp16.onnx.data", 67419136, "5ebbca207937d92ef6fab97f165db4f68a3d7363df4e11e3023e872c7d7fa6ab"),
      trtModel("ck2-stage1-trt-fp16-ctx.onnx", 1785, "f37de06c507fcd59e28890e57a15fedc485a160be4735ae066c45c8983f463f8"),
      trtModel("ck2-stage1-trt-fp16.onnx", 2406474, "b11fc352da8b5e5dcfb9cf96d5fe9884f15b1ffe96b176f045faecacc7a2bc4b"),
      trtModel("ck2-stage1-trt-fp16.onnx.data", 1125709568, "c11bc52e05d75773900b80b5b5ee28b6ddab0bbe1062e3f8d9857dcf69cde815"),
      trtModel("ck2-stage2-trt-fp16-ctx.onnx", 843, "dd4183754f269fe4999384baf1fc689e13e12e24062a40b6dd87806ba289990e"),
      trtModel("ck2-stage2-trt-fp16.onnx", 1297232, "8222676536502527095915bcb9dd2df8ac7a3741344f7bf4825817e05b85b646"),
      trtModel("ck2-stage2-trt-fp16.onnx.data", 425429504, "ab6eae0f8c68a5056514f1e4a542a0bdefacc58ba9ef9bd9727f9577e1e38668"),
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
  // earlier model sets whose files a TensorRT file may equal, copied from their folder when it is still installed
  older?: { name: string; files: Download[] }[];
}
// each model set's TensorRT set, installed into that set's folder (row 168): onnx.4 → 2.0.0-onnx.4-trt; onnx.5 keeps
// it too (Marcy's dev.2 pin above) until 2.0.0-onnx.5-trt is measured
const TRT_SETS: Record<string, { name: string; files: Download[] }> = { [MODEL_SET]: TENSORRT.models, [OLD_MODEL_SET]: TENSORRT.models };
/**
 * What the TensorRT install puts on the chosen set. onnx.5 copies C-RADIO's TensorRT weights (onnx.4's
 * ck2-cradio-fp16.onnx.data, 1.72 GB) from an installed 2.0.0-onnx.4 folder; onnx.4 has them in its own folder.
 */
export function trtCatalogFor(set: string, platform: NodeJS.Platform = PLATFORM): TrtCatalog {
  const c = catalogFor(set, platform);
  return { ...c, libs: TENSORRT.libs, trtModels: TRT_SETS[c.models.name], older: c.models.name === MODEL_SET ? [MODELS_ONNX4] : [] };
}
const TRT_CATALOG: TrtCatalog = trtCatalogFor(MODEL_SET);

/** Where the TensorRT parts go: into the installed runtime and model set. */
export function trtPaths(data: string, c: Catalog = TRT_CATALOG) {
  const runtime = join(data, RUNTIME_DIR, c.runtime.name);
  const models = join(data, MODELS_DIR, c.models.name);
  return { runtime, libs: join(runtime, TRT_LIBS_DIR), provider: join(runtime, "onnxruntime", "capi", TRT_PROVIDER), models, list: join(models, TRT_MODELS_LIST) };
}

/**
 * Where an installed set may already have a TensorRT file's bytes (C-RADIO's weights): the normal set's folder first,
 * then the older sets' (`root`: the models folder). Copied from the first that is there and checked, not downloaded.
 */
function localTwins(f: Download, c: Catalog & { older?: TrtCatalog["older"] }, root: string): string[] {
  // loop: NOT-WORTH — two sets' dozen files, once per plan
  return [c.models, ...(c.older ?? [])].flatMap((s) => s.files.filter((m) => m.sha256 === f.sha256 && m.size === f.size).map((m) => join(root, s.name, m.file)));
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
  // loop: NOT-WORTH — at most two candidate paths per file
  const copied = (f: Download) => localTwins(f, c, dirname(p.models)).some((t) => exists(t));
  // loop: NOT-WORTH — sixteen model files, once per plan
  const modelBytes = total(c.trtModels.files.filter((f) => !copied(f)));
  return { libs, provider, models, bytes: (libs ? c.libs.size : 0) + (provider ? ortWheel(c).size : 0) + (models ? modelBytes : 0) };
}

/** The TensorRT download on top of a 1.0 runtime and the chosen set (what the setting's hint names; less where an older set is still installed). */
export function trtBytesFor(set: string, platform: NodeJS.Platform = PLATFORM): number {
  const c = trtCatalogFor(set, platform);
  // loop: NOT-WORTH — sixteen model files, per state refresh (the set's own files only: older sets may be gone)
  return c.libs.size + total(c.trtModels.files.filter((f) => !localTwins(f, { ...c, older: [] }, "").length));
}
export const TRT_BYTES = trtBytesFor(MODEL_SET);

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

/** Whether a job asks the engine for TensorRT: Linux, the setting on, its parts installed. */
export function useTensorrt(s: { platform: NodeJS.Platform; setting: boolean; ready: boolean }): boolean {
  return trtSupported(s.platform) && s.setting && s.ready;
}

/**
 * Why a job doesn't ask for TensorRT, in the words the job page shows (useTensorrt's conditions, in order). Null when
 * it asks, and where TensorRT doesn't exist in this version (Windows, macOS): nothing to decide there.
 */
export function tensorrtWhyNot(s: { platform: NodeJS.Platform; setting: boolean; ready: boolean }): string | null {
  if (!trtSupported(s.platform) || useTensorrt(s)) return null;
  if (!s.setting) return "TensorRT is off (Engine settings)";
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
  const downloads = join(data, DOWNLOADS_DIR);
  // what a stopped install already has on the disk (the wheels, the model files in the partial folder or moved into the
  // set): only the rest needs room
  const trtPartial = join(data, MODELS_DIR, `.partial-${c.trtModels.name}`);
  const have =
    (need.libs ? already(join(downloads, c.libs.file), c.libs.size) : 0) +
    (need.provider ? already(join(downloads, ortWheel(c).file), ortWheel(c).size) : 0) +
    // loop: NOT-WORTH — sixteen planned files, once per install start
    (need.models ? c.trtModels.files.reduce((n, f) => n + Math.max(already(join(trtPartial, f.file), f.size), f.file === "models.json" ? 0 : already(join(p.models, f.file), f.size)), 0) : 0);
  const needRoom = (need.libs ? c.libs.size * 1.8 : 0) + (need.provider ? ortWheel(c).size : 0) + (need.models ? total(c.trtModels.files) : 0) - have;
  if (room !== null && room < needRoom) throw noRoom(needRoom, data, room);
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
      // loop: NOT-WORTH — a few stats per model file
      const twinPath = localTwins(f, c, dirname(p.models)).find((t) => existsSync(t));
      const fromTwin = !!twinPath;
      // loop: NOT-WORTH — one stat per model file
      if (!existsSync(target)) {
        // a crash after the moves below left it in the set's folder already: taken back, and checked again
        // loop: NOT-WORTH — one stat + rename per model file
        if (f.file !== "models.json" && existsSync(join(p.models, f.file))) renameSync(join(p.models, f.file), target);
        else if (fromTwin) {
          deps.progress(done(), need.bytes, `Copying ${f.file} from the CorridorKey models`);
          // off the main thread: on a file system without reflinks (ext4, NTFS) it is a real 1.7 GB copy, which as a sync
          // call froze the window for its length (measured 1.0 s on an NVMe SSD, bug hunt 2026-10-26 I2)
          // loop: SERIAL-REQUIRED — one local copy (a reflink where the file system has them) [bounded: 1.7 GB]
          await copyFile(twinPath!, target, constants.COPYFILE_FICLONE);
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
