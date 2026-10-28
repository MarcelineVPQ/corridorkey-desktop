//! The engine's settings, read once at startup from its command line and CK_ENGINE_* environment variables
//! (docs/ENGINE_RUST.md "Knobs"), checked (an unknown value is an error, not a silent default), logged to stderr and
//! sent in the pong. Nothing below reads the environment after this (job requests carry their own options).
use crate::runtime::{Precision, PIECES};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::time::Duration;

/// --device / CK_ENGINE_DEVICE.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Device {
    /// the graphics card (none: jobs fail with `no-gpu`)
    Auto,
    /// the same as auto (the card, through the CUDA provider)
    Cuda,
    /// ONNX Runtime's CPU provider (tests; slow)
    Cpu,
    /// ONNX Runtime's Core ML provider (macOS only; the fixed-shape Core ML model set, coreml.json)
    CoreMl,
    /// ONNX Runtime's MIGraphX provider: an AMD card (Linux only; the onnxruntime-migraphx build and ROCm, docs/AMD.md)
    Migraphx,
}

impl Device {
    pub fn name(&self) -> &'static str {
        match self {
            Device::Auto => "auto",
            Device::Cuda => "cuda",
            Device::Cpu => "cpu",
            Device::CoreMl => "coreml",
            Device::Migraphx => "migraphx",
        }
    }
}

/// CK_ENGINE_COREML_UNITS: what Core ML may run the networks on (its MLComputeUnits). Default cpu-gpu: with the
/// Neural Engine allowed (all), every session load compiled stage 2 for it again (~145 s each time, a new ~0.9 GB
/// bundle in Core ML's cache, the compiled model in ours reused) and its first call passed 9.7 GB; on CPU + GPU it
/// loads in 0.5-1.5 s and a whole HD job peaks at 1.8-3.4 GB, mattes within 1/255 of CUDA (Mac mini M6, 2026-10-27).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CoremlUnits {
    /// CPU, GPU and Neural Engine (Core ML picks per layer)
    All,
    CpuGpu,
    CpuAne,
    Cpu,
}

impl CoremlUnits {
    pub fn name(&self) -> &'static str {
        match self {
            CoremlUnits::All => "all",
            CoremlUnits::CpuGpu => "cpu-gpu",
            CoremlUnits::CpuAne => "cpu-ane",
            CoremlUnits::Cpu => "cpu",
        }
    }
}

/// CK_ENGINE_GRAPH_OPT: ONNX Runtime's graph optimisation level (a measurement knob).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GraphOpt {
    /// ORT_ENABLE_ALL (Python's default)
    All,
    /// ORT_ENABLE_LAYOUT (the `ort` crate's Level3)
    Layout,
    /// ORT_ENABLE_EXTENDED
    Extended,
}

/// CK_ENGINE_CUDNN_SEARCH: cuDNN's convolution algorithm search.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CudnnSearch {
    Heuristic,
    Exhaustive,
    Default,
}

/// CK_ENGINE_ARENA_SHRINK: which networks give their arena's working memory back after each run.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ArenaShrink {
    /// only while stage 1 and stage 2 are loaded together (runtime::shrinks)
    Auto,
    All,
    None,
    /// these networks
    List(Vec<String>),
}

#[derive(Clone, Debug, PartialEq)]
pub struct EngineConfig {
    /// --models / CK_ENGINE_MODELS (required to start)
    pub models: Option<PathBuf>,
    /// --ort / CK_ENGINE_ORT / ORT_DYLIB_PATH: ONNX Runtime's library (the load-dynamic build)
    pub ort: Option<PathBuf>,
    pub device: Device,
    /// CK_ENGINE_PRECISION: None = fp16 on the card, fp32 on the CPU
    pub precision: Option<Precision>,
    /// CK_ENGINE_THREADS: ONNX Runtime's intra-op threads (0 = its default)
    pub threads: usize,
    pub graph_opt: GraphOpt,
    pub cudnn_search: CudnnSearch,
    /// CK_ENGINE_CUDNN_MAX_WORKSPACE: None = ONNX Runtime's default
    pub cudnn_max_workspace: Option<bool>,
    /// CK_ENGINE_PROFILE: a folder for ONNX Runtime's per-node profiles
    pub profile: Option<PathBuf>,
    pub arena_shrink: ArenaShrink,
    /// CK_ENGINE_VRAM_BUDGET_GB: the default of a job's `vram_budget_gb`
    pub vram_budget_gb: Option<f64>,
    /// the TensorRT engine cache root (CK_ENGINE_TRT_CACHE, else the system's cache folder: pipeline::trt_root_for)
    pub trt_cache: PathBuf,
    /// CK_ENGINE_COREML_UNITS (default cpu-gpu)
    pub coreml_units: CoremlUnits,
    /// Core ML's compiled-model cache root (CK_ENGINE_COREML_CACHE, else `coreml` next to the TensorRT cache root)
    pub coreml_cache: PathBuf,
    /// CK_ENGINE_COREML_FAST_PREDICTION=1: Core ML's SpecializationStrategy FastPrediction (faster calls for a longer
    /// load, more memory and disk, per Apple). Off by default: a measurement knob, not measured yet
    pub coreml_fast_prediction: bool,
    /// CK_ENGINE_COREML_LOW_PRECISION_GPU=1: Core ML's AllowLowPrecisionAccumulationOnGPU (float16 sums on the GPU
    /// instead of float32). Off by default: a measurement knob; mattes must stay within the CUDA bar to keep it
    pub coreml_low_precision_gpu: bool,
    /// MIGraphX's compiled-program cache root (CK_ENGINE_MIGRAPHX_CACHE, else `migraphx` next to the TensorRT cache root)
    pub migraphx_cache: PathBuf,
    /// CK_ENGINE_MIGRAPHX_EP: AMD's MIGraphX provider plugin (libmigraphx-ep.so; else found next to ONNX Runtime's package)
    pub migraphx_ep: Option<PathBuf>,
    /// CK_ENGINE_TRT_BUILD: the engine builder (None: ck-trt-build next to the engine)
    pub trt_build: Option<PathBuf>,
    /// CK_ENGINE_TRT_BUILD_TIMEOUT_S: one engine build's deadline (1800 s)
    pub trt_build_timeout: Duration,
    /// CK_ENGINE_PARENT_PID: the app's pid (the engine ends with it)
    pub parent_pid: Option<u32>,
    /// ORT_ENABLE_CUDNN_FLASH_ATTENTION as the sessions see it (`set_process_env`)
    pub cudnn_flash_attention: Option<String>,
}

impl Default for EngineConfig {
    /// Every knob unset (tests and benches; the engine parses its own).
    fn default() -> Self {
        EngineConfig {
            models: None,
            ort: None,
            device: Device::Auto,
            precision: None,
            threads: 0,
            graph_opt: GraphOpt::All,
            cudnn_search: CudnnSearch::Heuristic,
            cudnn_max_workspace: None,
            profile: None,
            arena_shrink: ArenaShrink::Auto,
            vram_budget_gb: None,
            trt_cache: PathBuf::from("tensorrt"),
            coreml_units: CoremlUnits::CpuGpu,
            coreml_cache: PathBuf::from("coreml"),
            coreml_fast_prediction: false,
            coreml_low_precision_gpu: false,
            migraphx_cache: PathBuf::from("migraphx"),
            migraphx_ep: None,
            trt_build: None,
            trt_build_timeout: Duration::from_secs(1800),
            parent_pid: None,
            cudnn_flash_attention: None,
        }
    }
}

/// The value of `--name VALUE` or `--name=VALUE`.
fn arg_value(args: &[String], name: &str) -> Option<String> {
    // loop: NOT-WORTH — the command line, once per process
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1).cloned()).or_else(|| {
        let p = format!("{name}=");
        // loop: NOT-WORTH — the command line, once per process
        args.iter().find_map(|a| a.strip_prefix(&p).map(|s| s.to_string()))
    })
}

/// One of `choices` (case-insensitive), or an error that lists them.
fn pick<T: Copy>(name: &str, v: &str, choices: &[(&str, T)]) -> Result<T, String> {
    let low = v.trim().to_ascii_lowercase();
    // loop: NOT-WORTH — a few choices, once per process
    choices.iter().find(|(k, _)| *k == low).map(|(_, t)| *t).ok_or_else(|| {
        // loop: NOT-WORTH — the choices for the message
        let names: Vec<&str> = choices.iter().map(|(k, _)| *k).collect();
        format!("{name}: unknown value {v:?} ({})", names.join(" | "))
    })
}

impl EngineConfig {
    /// Read the settings from the command line `args` and the environment `env` (empty values count as unset), on
    /// system `os` (std::env::consts::OS). Err: what is wrong, naming the variable or flag.
    pub fn parse(args: &[String], env: &dyn Fn(&str) -> Option<String>, os: &str) -> Result<EngineConfig, String> {
        let var = |k: &str| env(k).filter(|s| !s.trim().is_empty());
        let device = match arg_value(args, "--device").map(|v| ("--device", v)).or_else(|| var("CK_ENGINE_DEVICE").map(|v| ("CK_ENGINE_DEVICE", v))) {
            Some((name, v)) => {
                let d = pick(
                    name,
                    &v,
                    &[("auto", Device::Auto), ("cuda", Device::Cuda), ("cpu", Device::Cpu), ("coreml", Device::CoreMl), ("migraphx", Device::Migraphx)],
                )?;
                if d == Device::CoreMl && os != "macos" {
                    return Err(format!("{name}: coreml is ONNX Runtime's Core ML provider, macOS only (this system: {os})"));
                }
                if d == Device::Migraphx && os != "linux" {
                    return Err(format!("{name}: migraphx is ONNX Runtime's MIGraphX provider for AMD cards, Linux only (this system: {os})"));
                }
                d
            }
            None => Device::Auto,
        };
        let coreml_units = match var("CK_ENGINE_COREML_UNITS") {
            Some(v) => pick(
                "CK_ENGINE_COREML_UNITS",
                &v,
                &[("all", CoremlUnits::All), ("cpu-gpu", CoremlUnits::CpuGpu), ("cpu-ane", CoremlUnits::CpuAne), ("cpu", CoremlUnits::Cpu)],
            )?,
            None => CoremlUnits::CpuGpu,
        };
        let trt_cache = crate::pipeline::trt_root_for(os, |k| var(k));
        let coreml_cache = var("CK_ENGINE_COREML_CACHE")
            .map(PathBuf::from)
            .unwrap_or_else(|| trt_cache.parent().map(|p| p.join("coreml")).unwrap_or_else(|| PathBuf::from("coreml")));
        let on_off = |k: &str| match var(k) {
            Some(v) => pick(k, &v, &[("0", false), ("1", true), ("false", false), ("true", true)]),
            None => Ok(false),
        };
        let coreml_fast_prediction = on_off("CK_ENGINE_COREML_FAST_PREDICTION")?;
        let coreml_low_precision_gpu = on_off("CK_ENGINE_COREML_LOW_PRECISION_GPU")?;
        let migraphx_cache = var("CK_ENGINE_MIGRAPHX_CACHE")
            .map(PathBuf::from)
            .unwrap_or_else(|| trt_cache.parent().map(|p| p.join("migraphx")).unwrap_or_else(|| PathBuf::from("migraphx")));
        let precision = match var("CK_ENGINE_PRECISION") {
            Some(v) => Some(pick("CK_ENGINE_PRECISION", &v, &[("fp16", Precision::Fp16), ("fp32", Precision::Fp32)])?),
            None => None,
        };
        let threads = match var("CK_ENGINE_THREADS") {
            Some(v) => v.trim().parse::<usize>().map_err(|_| format!("CK_ENGINE_THREADS: not a thread count: {v:?}"))?,
            None => 0,
        };
        let graph_opt = match var("CK_ENGINE_GRAPH_OPT") {
            Some(v) => pick("CK_ENGINE_GRAPH_OPT", &v, &[("all", GraphOpt::All), ("layout", GraphOpt::Layout), ("extended", GraphOpt::Extended)])?,
            None => GraphOpt::All,
        };
        let cudnn_search = match var("CK_ENGINE_CUDNN_SEARCH") {
            Some(v) => pick(
                "CK_ENGINE_CUDNN_SEARCH",
                &v,
                &[("heuristic", CudnnSearch::Heuristic), ("exhaustive", CudnnSearch::Exhaustive), ("default", CudnnSearch::Default)],
            )?,
            None => CudnnSearch::Heuristic,
        };
        let cudnn_max_workspace = match var("CK_ENGINE_CUDNN_MAX_WORKSPACE") {
            Some(v) => Some(pick("CK_ENGINE_CUDNN_MAX_WORKSPACE", &v, &[("0", false), ("1", true), ("false", false), ("true", true)])?),
            None => None,
        };
        let arena_shrink = match var("CK_ENGINE_ARENA_SHRINK") {
            None => ArenaShrink::Auto,
            Some(v) => match v.trim().to_ascii_lowercase().as_str() {
                "all" | "1" => ArenaShrink::All,
                "0" | "none" => ArenaShrink::None,
                list => {
                    // loop: NOT-WORTH — a short list of network names, once per process
                    let names: Vec<String> = list.split(',').map(|p| p.trim().to_string()).filter(|p| !p.is_empty()).collect();
                    // loop: NOT-WORTH — as above
                    if let Some(bad) = names.iter().find(|n| !PIECES.contains(&n.as_str())) {
                        return Err(format!("CK_ENGINE_ARENA_SHRINK: unknown network {bad:?} (all | none | a list of {})", PIECES.join(", ")));
                    }
                    ArenaShrink::List(names)
                }
            },
        };
        let vram_budget_gb = match var("CK_ENGINE_VRAM_BUDGET_GB") {
            Some(v) => match v.trim().parse::<f64>() {
                Ok(g) if g.is_finite() && g > 0.0 => Some(g),
                _ => return Err(format!("CK_ENGINE_VRAM_BUDGET_GB: not a number of GB above 0: {v:?}")),
            },
            None => None,
        };
        let trt_build_timeout = match var("CK_ENGINE_TRT_BUILD_TIMEOUT_S") {
            Some(v) => {
                Duration::from_secs(v.trim().parse::<u64>().map_err(|_| format!("CK_ENGINE_TRT_BUILD_TIMEOUT_S: not a number of seconds: {v:?}"))?.max(1))
            }
            None => Duration::from_secs(1800),
        };
        Ok(EngineConfig {
            models: arg_value(args, "--models").or_else(|| var("CK_ENGINE_MODELS")).map(PathBuf::from),
            ort: arg_value(args, "--ort").or_else(|| var("CK_ENGINE_ORT")).or_else(|| var("ORT_DYLIB_PATH")).map(PathBuf::from),
            device,
            precision,
            threads,
            graph_opt,
            cudnn_search,
            cudnn_max_workspace,
            profile: var("CK_ENGINE_PROFILE").map(PathBuf::from),
            arena_shrink,
            vram_budget_gb,
            trt_cache,
            coreml_units,
            coreml_cache,
            coreml_fast_prediction,
            coreml_low_precision_gpu,
            migraphx_cache,
            migraphx_ep: var("CK_ENGINE_MIGRAPHX_EP").map(PathBuf::from),
            trt_build: var("CK_ENGINE_TRT_BUILD").map(PathBuf::from),
            trt_build_timeout,
            parent_pid: crate::proc::parent_pid_from(var("CK_ENGINE_PARENT_PID").as_deref()),
            cudnn_flash_attention: env("ORT_ENABLE_CUDNN_FLASH_ATTENTION"),
        })
    }

    /// The settings as the pong's `config` (additive) and the startup log show them.
    pub fn to_json(&self) -> Value {
        let path = |p: &Option<PathBuf>| p.as_ref().map(|p| p.to_string_lossy().into_owned());
        json!({
            "models": path(&self.models),
            "ort": path(&self.ort),
            "device": self.device.name(),
            "precision": self.precision.map(|p| p.name()),
            "threads": self.threads,
            "graph_opt": match self.graph_opt { GraphOpt::All => "all", GraphOpt::Layout => "layout", GraphOpt::Extended => "extended" },
            "cudnn_search": match self.cudnn_search {
                CudnnSearch::Heuristic => "heuristic",
                CudnnSearch::Exhaustive => "exhaustive",
                CudnnSearch::Default => "default",
            },
            "cudnn_max_workspace": self.cudnn_max_workspace,
            "cudnn_flash_attention": self.cudnn_flash_attention,
            "profile": path(&self.profile),
            "arena_shrink": match &self.arena_shrink {
                ArenaShrink::Auto => json!("auto"),
                ArenaShrink::All => json!("all"),
                ArenaShrink::None => json!("none"),
                ArenaShrink::List(l) => json!(l),
            },
            "vram_budget_gb": self.vram_budget_gb,
            "trt_cache": self.trt_cache.to_string_lossy(),
            "coreml_units": self.coreml_units.name(),
            "coreml_cache": self.coreml_cache.to_string_lossy(),
            "coreml_fast_prediction": self.coreml_fast_prediction,
            "coreml_low_precision_gpu": self.coreml_low_precision_gpu,
            "migraphx_cache": self.migraphx_cache.to_string_lossy(),
            "migraphx_ep": path(&self.migraphx_ep),
            "trt_build": path(&self.trt_build),
            "trt_build_timeout_s": self.trt_build_timeout.as_secs(),
            "parent_pid": self.parent_pid,
        })
    }
}

/// Process-wide environment ONNX Runtime reads itself, set before anything else runs: attention on ORT's own flash
/// kernels, not cuDNN's (ORT_ENABLE_CUDNN_FLASH_ATTENTION=0 unless it is set already). Measured (RTX 5080, ORT 1.31,
/// 1280x1152): with cuDNN's, every switch between two sessions costs 250-400 ms of host time on the next run (stage 2
/// after a stage-1 window: 54 -> ~350 ms; stage 1 at T=8 ~250 -> ~530 ms), which normal mode does every window;
/// ORT's kernels have no such cost and are as fast (stage 1 at T=24 907 vs 915 ms of GPU time).
///
/// Why an environment variable and not a session option: the CUDA provider's `sdpa_kernel` option replaces ORT's
/// whole choice of attention kernels with a fixed set, which could pick other kernels (and other fp16 rounding) than
/// today's measured, bit-checked mattes; this variable only switches cuDNN's kernels off. Call it first in main(),
/// before any thread exists (std::env::set_var is not safe while another thread reads the environment).
pub fn set_process_env() {
    if std::env::var_os("ORT_ENABLE_CUDNN_FLASH_ATTENTION").is_none() {
        std::env::set_var("ORT_ENABLE_CUDNN_FLASH_ATTENTION", "0");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> {
        // loop: NOT-WORTH — a test's few variables
        move |k: &str| pairs.iter().find(|(n, _)| *n == k).map(|(_, v)| v.to_string())
    }

    fn args(a: &[&str]) -> Vec<String> {
        // loop: NOT-WORTH — a test's few arguments
        a.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn nothing_set_is_the_defaults() {
        let c = EngineConfig::parse(&args(&["corridorkey-engine"]), &env(&[("HOME", "/h")]), "linux").unwrap();
        let d = EngineConfig {
            trt_cache: PathBuf::from("/h/.cache/corridorkey-desktop/tensorrt"),
            coreml_cache: PathBuf::from("/h/.cache/corridorkey-desktop/coreml"),
            migraphx_cache: PathBuf::from("/h/.cache/corridorkey-desktop/migraphx"),
            ..EngineConfig::default()
        };
        assert_eq!(c, d);
    }

    #[test]
    fn flags_win_over_the_environment() {
        let e = env(&[("CK_ENGINE_DEVICE", "cuda"), ("CK_ENGINE_MODELS", "/env/models"), ("CK_ENGINE_ORT", "/env/ort.so"), ("ORT_DYLIB_PATH", "/x.so")]);
        let c = EngineConfig::parse(&args(&["e", "--device", "cpu", "--models=/m"]), &e, "linux").unwrap();
        assert_eq!((c.device, c.models, c.ort), (Device::Cpu, Some(PathBuf::from("/m")), Some(PathBuf::from("/env/ort.so"))));
        let c = EngineConfig::parse(&args(&["e"]), &env(&[("ORT_DYLIB_PATH", "/x.so")]), "linux").unwrap();
        assert_eq!(c.ort, Some(PathBuf::from("/x.so")));
    }

    #[test]
    fn every_knob_is_read() {
        let e = env(&[
            ("CK_ENGINE_PRECISION", "FP32"),
            ("CK_ENGINE_THREADS", "6"),
            ("CK_ENGINE_GRAPH_OPT", "layout"),
            ("CK_ENGINE_CUDNN_SEARCH", "exhaustive"),
            ("CK_ENGINE_CUDNN_MAX_WORKSPACE", "0"),
            ("CK_ENGINE_PROFILE", "/prof"),
            ("CK_ENGINE_ARENA_SHRINK", "rvm, stage1"),
            ("CK_ENGINE_VRAM_BUDGET_GB", "12"),
            ("CK_ENGINE_TRT_CACHE", "/trt"),
            ("CK_ENGINE_TRT_BUILD", "/b/ck-trt-build"),
            ("CK_ENGINE_TRT_BUILD_TIMEOUT_S", "0"),
            ("CK_ENGINE_PARENT_PID", "4242"),
            ("ORT_ENABLE_CUDNN_FLASH_ATTENTION", "0"),
            ("CK_ENGINE_COREML_FAST_PREDICTION", "1"),
            ("CK_ENGINE_COREML_LOW_PRECISION_GPU", "true"),
        ]);
        let c = EngineConfig::parse(&args(&["e"]), &e, "windows").unwrap();
        assert_eq!((c.precision, c.threads, c.graph_opt, c.cudnn_search), (Some(Precision::Fp32), 6, GraphOpt::Layout, CudnnSearch::Exhaustive));
        assert_eq!((c.cudnn_max_workspace, c.profile.clone(), c.vram_budget_gb), (Some(false), Some(PathBuf::from("/prof")), Some(12.0)));
        assert_eq!(c.arena_shrink, ArenaShrink::List(vec!["rvm".into(), "stage1".into()]));
        assert_eq!(
            (c.trt_cache.clone(), c.trt_build.clone(), c.trt_build_timeout),
            (PathBuf::from("/trt"), Some(PathBuf::from("/b/ck-trt-build")), Duration::from_secs(1))
        );
        assert_eq!((c.parent_pid, c.cudnn_flash_attention.as_deref()), (Some(4242), Some("0")));
        assert_eq!((c.coreml_fast_prediction, c.coreml_low_precision_gpu), (true, true));
        let j = c.to_json();
        assert_eq!((j["coreml_fast_prediction"].as_bool(), j["coreml_low_precision_gpu"].as_bool()), (Some(true), Some(true)));
        assert_eq!((j["precision"].as_str(), j["graph_opt"].as_str(), j["arena_shrink"][1].as_str()), (Some("fp32"), Some("layout"), Some("stage1")));
        assert_eq!((j["trt_build_timeout_s"].as_u64(), j["vram_budget_gb"].as_f64()), (Some(1), Some(12.0)));
    }

    #[test]
    fn unknown_values_are_errors_not_silent_defaults() {
        // loop: NOT-WORTH — a test's few settings
        for (k, v) in [
            ("CK_ENGINE_DEVICE", "gpu"),
            ("CK_ENGINE_PRECISION", "bf16"),
            ("CK_ENGINE_GRAPH_OPT", "max"),
            ("CK_ENGINE_CUDNN_SEARCH", "fast"),
            ("CK_ENGINE_CUDNN_MAX_WORKSPACE", "yes"),
            ("CK_ENGINE_THREADS", "many"),
            ("CK_ENGINE_ARENA_SHRINK", "stage3"),
            ("CK_ENGINE_VRAM_BUDGET_GB", "-2"),
            ("CK_ENGINE_VRAM_BUDGET_GB", "lots"),
            ("CK_ENGINE_TRT_BUILD_TIMEOUT_S", "1h"),
            ("CK_ENGINE_COREML_UNITS", "gpu"),
            ("CK_ENGINE_COREML_FAST_PREDICTION", "yes"),
            ("CK_ENGINE_COREML_LOW_PRECISION_GPU", "fp16"),
        ] {
            let e = move |n: &str| (n == k).then(|| v.to_string());
            let err = EngineConfig::parse(&args(&["e"]), &e, "linux").unwrap_err();
            assert!(err.starts_with(k), "{k}={v}: {err}");
        }
        assert!(EngineConfig::parse(&args(&["e", "--device", "metal"]), &env(&[]), "linux").unwrap_err().starts_with("--device"));
        // Core ML: macOS only, a clear error elsewhere; on macOS its units and cache
        assert!(EngineConfig::parse(&args(&["e", "--device", "coreml"]), &env(&[]), "linux").unwrap_err().contains("macOS only"));
        let c =
            EngineConfig::parse(&args(&["e", "--device", "coreml"]), &env(&[("HOME", "/Users/m"), ("CK_ENGINE_COREML_UNITS", "cpu-gpu")]), "macos").unwrap();
        assert_eq!((c.device, c.coreml_units), (Device::CoreMl, CoremlUnits::CpuGpu));
        // unset: CPU + GPU, not the Neural Engine (its compile isn't reused between loads; 9.7 GB at stage 2)
        let c = EngineConfig::parse(&args(&["e", "--device", "coreml"]), &env(&[("HOME", "/Users/m")]), "macos").unwrap();
        assert_eq!((c.coreml_units, EngineConfig::default().coreml_units), (CoremlUnits::CpuGpu, CoremlUnits::CpuGpu));
        assert_eq!(c.coreml_cache, PathBuf::from("/Users/m/Library/Caches/corridorkey-desktop/coreml"));
        assert_eq!(c.to_json()["device"].as_str(), Some("coreml"));
        // MIGraphX: Linux only, a clear error elsewhere; on Linux its cache
        assert!(EngineConfig::parse(&args(&["e", "--device", "migraphx"]), &env(&[]), "windows").unwrap_err().contains("Linux only"));
        let e = env(&[("HOME", "/h"), ("CK_ENGINE_MIGRAPHX_CACHE", "/mx"), ("CK_ENGINE_MIGRAPHX_EP", "/ep/libmigraphx-ep.so")]);
        let c = EngineConfig::parse(&args(&["e", "--device=MIGraphX"]), &e, "linux").unwrap();
        assert_eq!((c.device, c.migraphx_cache.clone()), (Device::Migraphx, PathBuf::from("/mx")));
        assert_eq!(c.migraphx_ep, Some(PathBuf::from("/ep/libmigraphx-ep.so")));
        assert_eq!(c.to_json()["migraphx_cache"].as_str(), Some("/mx"));
        // empty means unset
        assert_eq!(EngineConfig::parse(&args(&["e"]), &env(&[("CK_ENGINE_DEVICE", ""), ("CK_ENGINE_THREADS", " ")]), "linux").unwrap().device, Device::Auto);
        // the arena values
        let s = |v: &'static str| {
            EngineConfig::parse(&args(&["e"]), &move |n: &str| (n == "CK_ENGINE_ARENA_SHRINK").then(|| v.to_string()), "linux").unwrap().arena_shrink
        };
        assert_eq!((s("all"), s("1"), s("0"), s("none")), (ArenaShrink::All, ArenaShrink::All, ArenaShrink::None, ArenaShrink::None));
    }
}
