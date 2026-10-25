//! The one model-loading layer: ONNX Runtime, its execution provider (CUDA by default on an NVIDIA card,
//! TensorRT when a job opts in, the CPU only when asked for), and the five networks' files.
//!
//! Models folder (`--models DIR`): one ONNX file per network and precision, found by `models.json` when the
//! folder has one ({"fp16": {"stage1": "stage1_op23fp16.onnx", ...}, "fp32": {...}}), else by the first
//! existing default name (`<piece>_fp16.onnx`, the spike's `<piece>_op23fp16.onnx`, ...). External weights
//! (`.onnx.data`) sit next to their file.
use crate::config::{ArenaShrink, Device, EngineConfig, GraphOpt};
use crate::gpu::{nvidia, GpuInfo};
use crate::pipeline::network::NetCounters;
use crate::Error;
use ort::session::builder::GraphOptimizationLevel;
use ort::session::Session;
use ort::value::{Tensor, TensorRef};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub(crate) const PIECES: [&str; 5] = ["cradio", "moge", "rvm", "stage1", "stage2"];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Provider {
    Cuda,
    TensorRt,
    Cpu,
    /// ONNX Runtime's Core ML provider (macOS): every node of a fixed-shape Core ML set file, or no session
    CoreMl,
}

impl Provider {
    pub fn name(&self) -> &'static str {
        match self {
            Provider::Cuda => "cuda",
            Provider::TensorRt => "tensorrt",
            Provider::Cpu => "cpu",
            Provider::CoreMl => "coreml",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Precision {
    Fp16,
    Fp32,
}

impl Precision {
    pub fn name(&self) -> &'static str {
        match self {
            Precision::Fp16 => "fp16",
            Precision::Fp32 => "fp32",
        }
    }
}

/// Default file names per precision, tried in order.
fn default_names(piece: &str, p: Precision) -> Vec<String> {
    match p {
        Precision::Fp16 => vec![format!("{piece}_fp16.onnx"), format!("{piece}_op23fp16.onnx"), format!("{piece}.fp16.onnx")],
        Precision::Fp32 => vec![format!("{piece}_fp32.onnx"), format!("{piece}_op23.onnx"), format!("{piece}.fp32.onnx"), format!("{piece}.onnx")],
    }
}

/// The models folder and its optional manifest.
#[derive(Clone, Debug)]
pub struct ModelSet {
    pub dir: PathBuf,
    manifest: BTreeMap<String, BTreeMap<String, String>>,
    /// manifest.json's "version" (CorridorKey2.0 make_manifest.py), when the folder has one
    pub(crate) version: Option<String>,
    /// coreml.json, when the folder has one: the Core ML set (fixed-shape files, engine-rs/export/coreml)
    pub(crate) coreml: Option<CoremlManifest>,
}

/// coreml.json: {"format": 1, "source_set": "2.0.0-onnx.3", "fp16": {"1152x1280": {"stage1-t4": "file.onnx", ...}}}.
/// Core ML compiles a model for fixed shapes, so there is one file per network, padded size (H x W) and batch
/// (`-t<T>`: frames per call). The files keep their weights in the set's own `.onnx.data` files.
#[derive(Clone, Debug, Default, serde::Deserialize)]
pub(crate) struct CoremlManifest {
    #[serde(default)]
    pub(crate) source_set: Option<String>,
    #[serde(default)]
    pub(crate) fp16: BTreeMap<String, BTreeMap<String, String>>,
}

/// Model sets whose C-RADIO only takes landscape or square frames (measured: an ONNX Runtime broadcast error
/// on every frame taller than wide: its export dropped the position grid's column crop). 2.0.0-onnx.3 on takes
/// portrait.
const LANDSCAPE_ONLY_SETS: [&str; 2] = ["2.0.0-onnx.1", "2.0.0-onnx.2"];

/// A model's size on disk: the .onnx file and its external weights (.onnx.data) next to it.
pub(crate) fn model_bytes(file: &Path) -> u64 {
    let data = PathBuf::from(format!("{}.data", file.display()));
    [file.to_path_buf(), data].iter().filter_map(|p| std::fs::metadata(p).ok()).map(|m| m.len()).sum()
}

impl ModelSet {
    pub fn open(dir: &Path) -> Result<ModelSet, Error> {
        let mpath = dir.join("models.json");
        let manifest = if mpath.exists() {
            let s = std::fs::read_to_string(&mpath).map_err(|e| Error::assets(format!("{}: {e}", mpath.display())))?;
            serde_json::from_str(&s).map_err(|e| Error::assets(format!("{}: {e}", mpath.display())))?
        } else {
            BTreeMap::new()
        };
        let version = std::fs::read_to_string(dir.join("manifest.json"))
            .ok()
            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
            .and_then(|v| v.get("version")?.as_str().map(str::to_string));
        let cpath = dir.join("coreml.json");
        let coreml = if cpath.exists() {
            let s = std::fs::read_to_string(&cpath).map_err(|e| Error::assets(format!("{}: {e}", cpath.display())))?;
            Some(serde_json::from_str(&s).map_err(|e| Error::assets(format!("{}: {e}", cpath.display())))?)
        } else {
            None
        };
        Ok(ModelSet { dir: dir.to_path_buf(), manifest, version, coreml })
    }

    /// The Core ML set's file for `piece` at padded size `sh` x `sw` and batch `t`. Err: why there is none (no
    /// coreml.json, no file for that size, the batches it has for that size, or the file is missing).
    pub(crate) fn coreml_file(&self, piece: &str, (sh, sw): (usize, usize), t: usize) -> Result<PathBuf, String> {
        let Some(cm) = &self.coreml else {
            return Err(format!("{} has no Core ML model set (coreml.json)", self.dir.display()));
        };
        if let (Some(from), Some(v)) = (&cm.source_set, &self.version) {
            if from != v {
                return Err(format!("the Core ML set (coreml.json) was built from model set {from}, this folder is {v}: its weights don't match"));
            }
        }
        let Some(files) = cm.fp16.get(&format!("{sh}x{sw}")) else {
            let have: Vec<&str> = cm.fp16.keys().map(|k| k.as_str()).collect();
            return Err(format!(
                "the Core ML set has no models for {sw}x{sh} frames (padded); it has {}",
                if have.is_empty() { "none".to_string() } else { have.join(", ") }
            ));
        };
        let Some(name) = files.get(&format!("{piece}-t{t}")) else {
            // loop: NOT-WORTH — the set's few batches, for the message
            let have: Vec<String> = self.coreml_batches(piece, (sh, sw)).iter().map(|t| t.to_string()).collect();
            return Err(format!(
                "the Core ML set has no {piece} for {t} frame(s) per call at {sw}x{sh} (it has {}): pick a window it was built for",
                if have.is_empty() { "none".to_string() } else { format!("{} frame(s)", have.join(", ")) }
            ));
        };
        let f = self.dir.join(name);
        if f.exists() {
            Ok(f)
        } else {
            Err(format!("Core ML model missing: {}", f.display()))
        }
    }

    /// The batches (frames per call) the Core ML set has for `piece` at `sh` x `sw`, smallest first.
    pub(crate) fn coreml_batches(&self, piece: &str, (sh, sw): (usize, usize)) -> Vec<usize> {
        let pre = format!("{piece}-t");
        let mut v: Vec<usize> = self
            .coreml
            .as_ref()
            .and_then(|c| c.fp16.get(&format!("{sh}x{sw}")))
            .map(|f| f.keys().filter_map(|k| k.strip_prefix(&pre)?.parse().ok()).collect())
            .unwrap_or_default();
        v.sort_unstable();
        v
    }

    /// Whether this set's C-RADIO takes frames taller than wide (false only for the sets measured to fail).
    pub(crate) fn takes_portrait(&self) -> bool {
        !self.version.as_deref().is_some_and(|v| LANDSCAPE_ONLY_SETS.contains(&v))
    }

    /// The file of `piece` at `p`, if there is one.
    pub(crate) fn file(&self, piece: &str, p: Precision) -> Option<PathBuf> {
        if let Some(name) = self.manifest.get(p.name()).and_then(|m| m.get(piece)) {
            let f = self.dir.join(name);
            return f.exists().then_some(f);
        }
        default_names(piece, p).into_iter().map(|n| self.dir.join(n)).find(|f| f.exists())
    }

    /// The TensorRT-ready export of `piece` at `p`: models.json's "tensorrt-fp16" / "tensorrt-fp32" (files
    /// TensorRT's ONNX parser takes: plain attention instead of com.microsoft::MultiHeadAttention, MoGe's
    /// antialiased resize as weight matrices, at most 8-dimensional tensors; CorridorKey2.0
    /// scripts/onnx_spike/to_trt.py). None: no such file, the network runs on CUDA.
    pub(crate) fn trt_file(&self, piece: &str, p: Precision) -> Option<PathBuf> {
        let name = self.manifest.get(&format!("tensorrt-{}", p.name()))?.get(piece)?;
        let f = self.dir.join(name);
        f.exists().then_some(f)
    }

    /// The EPContext stub for `piece`'s TensorRT engine (models.json "tensorrt-fp16-ctx": an ONNX file with the
    /// TensorRT-ready export's inputs and outputs and one EPContext node pointing at `<piece>.engine` next to it;
    /// CorridorKey2.0 scripts/onnx_spike/trt_ctx.py).
    pub(crate) fn trt_stub(&self, piece: &str, p: Precision) -> Option<PathBuf> {
        let name = self.manifest.get(&format!("tensorrt-{}-ctx", p.name()))?.get(piece)?;
        let f = self.dir.join(name);
        f.exists().then_some(f)
    }

    /// Which networks are there at `p` (the pong's "assets").
    pub fn assets(&self, p: Precision) -> BTreeMap<String, bool> {
        // loop: NOT-WORTH — five networks, once per ping
        PIECES.iter().map(|k| (k.to_string(), self.file(k, p).is_some())).collect()
    }

    pub(crate) fn missing(&self, p: Precision) -> Vec<String> {
        // loop: NOT-WORTH — five networks, once per job
        PIECES.iter().filter(|k| self.file(k, p).is_none()).map(|k| k.to_string()).collect()
    }
}

/// "1.31.0" from ORT's build info ("... git-branch=rel-1.31.0, ...").
pub(crate) fn ort_version(info: &str) -> String {
    // loop: NOT-WORTH — a short build-info string, once per process
    info.split(|c: char| c == ',' || c.is_whitespace()).find_map(|t| t.strip_prefix("git-branch=rel-")).unwrap_or(info).to_string()
}

/// The version a libonnxruntime reports (OrtGetApiBase()->GetVersionString), e.g. "1.31.0".
#[cfg(feature = "ort-dynamic")]
fn dylib_version(lib: &Path) -> Option<String> {
    #[repr(C)]
    struct ApiBase {
        get_api: unsafe extern "C" fn(u32) -> *const std::ffi::c_void,
        get_version_string: unsafe extern "C" fn() -> *const std::ffi::c_char,
    }
    // SAFETY: OrtGetApiBase returns a static OrtApiBase {GetApi, GetVersionString} (onnxruntime_c_api.h)
    unsafe {
        let l = libloading::Library::new(lib).ok()?;
        let f: libloading::Symbol<unsafe extern "C" fn() -> *const ApiBase> = l.get(b"OrtGetApiBase\0").ok()?;
        let base = f();
        if base.is_null() {
            return None;
        }
        let s = ((*base).get_version_string)();
        let v = std::ffi::CStr::from_ptr(s).to_string_lossy().into_owned();
        std::mem::forget(l); // ORT stays loaded for the process anyway
        Some(v)
    }
}

pub struct Runtime {
    env: ort::environment::Environment,
    pub gpu: Option<GpuInfo>,
    pub(crate) cuda_ep: bool,
    pub tensorrt_ep: bool,
    /// the loaded ONNX Runtime has the Core ML provider (macOS builds only; never true elsewhere)
    pub coreml_ep: bool,
    pub ort_version: String,
    /// the engine's settings, read once at startup (config.rs); everything below the protocol loop reads them here
    pub cfg: EngineConfig,
}

static GLOBAL: std::sync::OnceLock<Result<Runtime, String>> = std::sync::OnceLock::new();

impl Runtime {
    /// The process's runtime (one ORT environment per process), with the engine's settings: `cfg.ort` is
    /// libonnxruntime for a load-dynamic build.
    pub fn init(cfg: &EngineConfig) -> Result<&'static Runtime, Error> {
        GLOBAL.get_or_init(|| Runtime::new(cfg)).as_ref().map_err(|e| Error::engine(e.clone()))
    }

    fn new(cfg: &EngineConfig) -> Result<Runtime, String> {
        // (ORT_ENABLE_CUDNN_FLASH_ATTENTION: set by main before any thread, config::set_process_env)
        #[allow(unused_mut, unused_assignments)]
        let mut version: Option<String> = None;
        #[cfg(feature = "ort-dynamic")]
        let builder = {
            let lib = cfg
                .ort
                .as_ref()
                .map(|p| p.to_string_lossy().into_owned())
                .ok_or_else(|| "this build loads ONNX Runtime at run time: pass --ort (or CK_ENGINE_ORT) with libonnxruntime.so".to_string())?;
            version = dylib_version(Path::new(&lib));
            ort::init_from(&lib).map_err(|e| format!("{lib}: {e}"))?
        };
        #[cfg(not(feature = "ort-dynamic"))]
        let builder = ort::init();
        let env = builder.with_name("corridorkey-engine").build().map_err(|e| e.to_string())?;
        let version = version.unwrap_or_else(|| ort_version(ort::info()));
        #[cfg(feature = "cuda")]
        let cuda_ep = {
            use ort::ep::ExecutionProvider;
            ort::ep::CUDA::is_available().unwrap_or(false)
        };
        #[cfg(not(feature = "cuda"))]
        let cuda_ep = false;
        #[cfg(feature = "tensorrt")]
        let tensorrt_ep = {
            use ort::ep::ExecutionProvider;
            ort::ep::TensorRT::is_available().unwrap_or(false)
        };
        #[cfg(not(feature = "tensorrt"))]
        let tensorrt_ep = false;
        #[cfg(target_os = "macos")]
        let coreml_ep = {
            use ort::ep::ExecutionProvider;
            ort::ep::CoreML::is_available().unwrap_or(false)
        };
        #[cfg(not(target_os = "macos"))]
        let coreml_ep = false;
        let gpu = if matches!(cfg.device, Device::Cpu | Device::CoreMl) { None } else { nvidia() };
        Ok(Runtime { env, gpu, cuda_ep, tensorrt_ep, coreml_ep, ort_version: version, cfg: cfg.clone() })
    }

    /// The normal provider: CUDA with a card and the CUDA EP (or when asked), the CPU only when asked.
    /// Core ML only when asked for (--device coreml) and the loaded ONNX Runtime has it.
    /// None: no usable GPU (the protocol's `no-gpu`), or no Core ML provider (`unavailable_reason`).
    pub fn provider(&self) -> Option<Provider> {
        match self.cfg.device {
            Device::Cpu => Some(Provider::Cpu),
            Device::CoreMl => self.coreml_ep.then_some(Provider::CoreMl),
            _ if self.gpu.is_some() && self.cuda_ep => Some(Provider::Cuda),
            _ => None,
        }
    }

    /// fp16 on the GPU, fp32 on the CPU; CK_ENGINE_PRECISION overrides.
    pub fn precision(&self, prov: Provider) -> Precision {
        match self.cfg.precision {
            Some(p) => p,
            None if prov == Provider::Cpu => Precision::Fp32,
            None => Precision::Fp16,
        }
    }

    /// Why `provider()` is None, in words for the job's error.
    pub fn unavailable_reason(&self) -> String {
        match self.cfg.device {
            Device::CoreMl => format!(
                "--device coreml: this ONNX Runtime ({}) has no Core ML execution provider (the macOS onnxruntime build has it); nothing runs on the CPU instead",
                self.ort_version
            ),
            _ => "CorridorKey needs an NVIDIA graphics card with CUDA.".into(),
        }
    }

    fn builder(&self) -> Result<ort::session::builder::SessionBuilder, String> {
        let mut b = Session::builder(&self.env).map_err(|e| e.to_string())?;
        // the `ort` crate's Level3 is ORT_ENABLE_LAYOUT; All is ORT_ENABLE_ALL (what Python's default is).
        // CK_ENGINE_GRAPH_OPT = all | layout | extended (a measurement knob)
        let level = match self.cfg.graph_opt {
            GraphOpt::Layout => GraphOptimizationLevel::Level3,
            GraphOpt::Extended => GraphOptimizationLevel::Level2,
            GraphOpt::All => GraphOptimizationLevel::All,
        };
        b = b.with_optimization_level(level).map_err(|e| e.to_string())?;
        if self.cfg.threads > 0 {
            b = b.with_intra_threads(self.cfg.threads).map_err(|e| e.to_string())?;
        }
        Ok(b)
    }

    /// A session for `file` on `prov` (TensorRT: `file` is the network's EPContext stub, see TrtSettings).
    /// `vram_cap`: the most graphics memory (bytes) the session's CUDA arena may hold (gpu_mem_limit).
    pub(crate) fn session(&self, prov: Provider, file: &Path, vram_cap: Option<u64>) -> Result<Session, String> {
        let _ = vram_cap;
        let mut b = self.builder()?;
        // CK_ENGINE_PROFILE=<folder>: ONNX Runtime's per-node profile of each session (a measurement knob)
        if let Some(dir) = &self.cfg.profile {
            let stem = file.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
            b = b.with_profiling(dir.join(stem)).map_err(|e| e.to_string())?;
        }
        match prov {
            Provider::Cpu => {}
            Provider::Cuda => {
                #[cfg(feature = "cuda")]
                {
                    b = b.with_execution_providers([cuda_ep(&self.cfg, vram_cap).build().error_on_failure()]).map_err(|e| e.to_string())?;
                }
                #[cfg(not(feature = "cuda"))]
                return Err("this engine was built without the CUDA execution provider".into());
            }
            Provider::TensorRt => {
                // `file` is an EPContext stub next to an engine ck-trt-build made (tensorrt.rs): TensorRT runs the
                // prebuilt engine, nothing is built here; the CUDA provider stays behind it
                #[cfg(feature = "tensorrt")]
                {
                    let ep = ort::ep::TensorRT::default().with_device_id(0);
                    b = b.with_execution_providers([ep.build().error_on_failure(), cuda_ep(&self.cfg, vram_cap).build()]).map_err(|e| e.to_string())?;
                }
                #[cfg(not(feature = "tensorrt"))]
                {
                    return Err("this engine was built without the TensorRT execution provider".into());
                }
            }
            Provider::CoreMl => {
                // every node on Core ML or no session: CPU fallback is switched off, so a node Core ML can't take is
                // an error naming the reason, never a silent CPU run
                #[cfg(target_os = "macos")]
                {
                    use ort::ep::coreml::{ComputeUnits, ModelFormat};
                    let cache = coreml_cache_dir(&self.cfg.coreml_cache, &self.ort_version, self.cfg.coreml_units.name(), file);
                    std::fs::create_dir_all(&cache).map_err(|e| format!("the Core ML cache folder {}: {e}", cache.display()))?;
                    let units = match self.cfg.coreml_units {
                        crate::config::CoremlUnits::All => ComputeUnits::All,
                        crate::config::CoremlUnits::CpuGpu => ComputeUnits::CPUAndGPU,
                        crate::config::CoremlUnits::CpuAne => ComputeUnits::CPUAndNeuralEngine,
                        crate::config::CoremlUnits::Cpu => ComputeUnits::CPUOnly,
                    };
                    let ep = ort::ep::CoreML::default()
                        .with_model_format(ModelFormat::MLProgram)
                        .with_compute_units(units)
                        .with_static_input_shapes(true)
                        .with_model_cache_dir(cache.display());
                    b = b.with_config_entry("session.disable_cpu_ep_fallback", "1").map_err(|e| e.to_string())?;
                    b = b.with_execution_providers([ep.build().error_on_failure()]).map_err(|e| e.to_string())?;
                }
                #[cfg(not(target_os = "macos"))]
                {
                    return Err("Core ML runs only on macOS".into());
                }
            }
        }
        b.commit_from_file(file).map_err(|e| e.to_string())
    }
}

#[cfg(feature = "cuda")]
fn cuda_ep(cfg: &EngineConfig, vram_cap: Option<u64>) -> ort::ep::CUDA {
    let mut ep = ort::ep::CUDA::default();
    if let Some(c) = vram_cap {
        ep = ep.with_memory_limit(c as usize);
    }
    // cuDNN's convolution algorithm search: heuristic. Measured (locked_backdrop, 1280x1152, 3 runs each): the
    // same stage 1 / stage 2 run times as ORT's exhaustive default, and no first-call outliers (RVM's first call
    // 0.4 s every run; exhaustive 0.2-3.0 s, job totals 21.8-22.1 s against 22.2-26.1 s).
    // CK_ENGINE_CUDNN_SEARCH = exhaustive | heuristic | default, CK_ENGINE_CUDNN_MAX_WORKSPACE = 0 | 1
    use crate::config::CudnnSearch;
    ep = ep.with_conv_algorithm_search(match cfg.cudnn_search {
        CudnnSearch::Exhaustive => ort::ep::cuda::ConvAlgorithmSearch::Exhaustive,
        CudnnSearch::Default => ort::ep::cuda::ConvAlgorithmSearch::Default,
        CudnnSearch::Heuristic => ort::ep::cuda::ConvAlgorithmSearch::Heuristic,
    });
    if let Some(v) = cfg.cudnn_max_workspace {
        ep = ep.with_conv_max_workspace(v);
    }
    ep.with_device_id(0)
        // the arena grows by what is asked: less held graphics memory
        .with_arena_extend_strategy(ort::ep::ArenaExtendStrategy::SameAsRequested)
        // TF32 off: an fp32 model on CUDA computes in fp32
        .with_tf32(false)
}

/// The compiled-model cache folder of one Core ML set file: `<root>/<ORT version>/<units>/<file stem>-<bytes>-<mtime>`.
/// The stem names the network, padded size and batch; size and modification time change when the file is rebuilt
/// (ORT's own cache key follows the graph's structure, not its weights).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn coreml_cache_dir(root: &Path, ort_version: &str, units: &str, file: &Path) -> PathBuf {
    let meta = std::fs::metadata(file).ok();
    let bytes = meta.as_ref().map(|m| m.len()).unwrap_or(0);
    let mtime = meta.and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0);
    let stem = file.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    root.join(ort_version).join(units).join(format!("{stem}-{bytes}-{mtime}"))
}

/// Where a TensorRT network's engine lives: the shape range's folder for this network (engine + EPContext stub).
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct TrtSettings {
    pub(crate) dir: PathBuf,
}

/// A loaded network: its session and how its inputs want to be fed (the pipeline's `Network`).
pub struct Net {
    pub(crate) piece: &'static str,
    // (end_profiling on drop when `profiling`)
    pub(crate) session: Session,
    pub(crate) provider: Provider,
    f16_inputs: Vec<String>,
    /// run options that give the arena's working memory back after the run (GPU only)
    shrink_options: Option<ort::session::RunOptions>,
    /// whether runs use `shrink_options` (the pipeline sets it from `shrinks` for what is loaded)
    pub(crate) shrink: bool,
    /// measured: seconds in session.run, seconds converting inputs/outputs, calls, the first run's seconds (reset
    /// per job)
    pub(crate) counters: NetCounters,
    /// CK_ENGINE_PROFILE is set: the session writes its profile when dropped
    profiling: bool,
}

impl Drop for Net {
    fn drop(&mut self) {
        if self.profiling {
            if let Ok(f) = self.session.end_profiling() {
                eprintln!("  profile of {}: {f}", self.piece);
            }
        }
    }
}

/// Whether `piece`'s arena gives its working memory back after each run. CK_ENGINE_ARENA_SHRINK: "all" / "1",
/// "0" / "none", or a comma list of networks. Default: only while stage 1 and stage 2 are loaded together
/// (`shared`, the normal mode), so their working memory doesn't add up. A network that has the card to itself
/// (the low-VRAM phases) keeps its arena: measured, a shrunk arena allocates its buffers again on the next run,
/// 159 ms per stage-2 call against 60 ms kept (1280x1152, docs/ENGINE_RUST.md).
pub(crate) fn shrinks(piece: &str, setting: &ArenaShrink, shared: bool) -> bool {
    match setting {
        ArenaShrink::All => true,
        ArenaShrink::None => false,
        ArenaShrink::List(list) => list.iter().any(|p| p == piece),
        ArenaShrink::Auto => shared,
    }
}

/// Tensor data in the type it already has: nothing is converted until a network needs another type, and
/// then in one pass. Every conversion is exact where the old float32 path was (bfloat16 and float16 values
/// are exact in float32; float32 -> float16 rounds once, as before).
pub enum Data<'a> {
    F32(Vec<f32>),
    F16(Vec<half::f16>),
    /// bfloat16 frames, concatenated in order (the decoded frames' model view: stage 1 and 2's rgb)
    Bf16(Vec<&'a [half::bf16]>),
    /// borrowed float16 / float32 data, fed to a graph of the same type without a copy (the all-zero hint of a
    /// window without hints is one buffer for the whole job)
    F16Ref(&'a [half::f16]),
    F32Ref(&'a [f32]),
}

impl From<Vec<f32>> for Data<'_> {
    fn from(v: Vec<f32>) -> Self {
        Data::F32(v)
    }
}

impl From<Vec<half::f16>> for Data<'_> {
    fn from(v: Vec<half::f16>) -> Self {
        Data::F16(v)
    }
}

/// Parallel conversions over large tensors: at least this many values per rayon task.
const PAR_MIN: usize = 1 << 14;

impl Data<'_> {
    pub(crate) fn len(&self) -> usize {
        match self {
            Data::F32(v) => v.len(),
            Data::F16(v) => v.len(),
            Data::Bf16(parts) => parts.iter().map(|p| p.len()).sum(),
            Data::F16Ref(v) => v.len(),
            Data::F32Ref(v) => v.len(),
        }
    }

    /// As float32 (exact for float16 / bfloat16).
    pub(crate) fn into_f32(self) -> Vec<f32> {
        use rayon::prelude::*;
        match self {
            Data::F32(v) => v,
            // loop: HOT-PATH-OK — float16 -> float32 where a graph takes float32 (the CPU / fp32 path), one parallel pass
            Data::F16(v) => v.par_iter().with_min_len(PAR_MIN).map(|x| x.to_f32()).collect(),
            Data::Bf16(parts) => concat_parts(&parts, |x| x.to_f32()),
            Data::F32Ref(v) => v.to_vec(),
            // loop: HOT-PATH-OK — a borrowed float16 input to a float32 graph, one parallel pass
            Data::F16Ref(v) => v.par_iter().with_min_len(PAR_MIN).map(|x| x.to_f32()).collect(),
        }
    }

    /// As float16 (float32 values round to nearest even, as `half::f16::from_f32`).
    pub(crate) fn into_f16(self) -> Vec<half::f16> {
        use rayon::prelude::*;
        match self {
            Data::F16(v) => v,
            // loop: HOT-PATH-OK — float32 -> float16 for the fp16 graphs' float32-made inputs (hints, foundation inputs on CPU), one parallel pass
            Data::F32(v) => v.par_iter().with_min_len(PAR_MIN).map(|&x| half::f16::from_f32(x)).collect(),
            Data::Bf16(parts) => concat_parts(&parts, |x| half::f16::from_f32(x.to_f32())),
            Data::F16Ref(v) => v.to_vec(),
            // loop: HOT-PATH-OK — a borrowed float32 input to a float16 graph, one parallel pass
            Data::F32Ref(v) => v.par_iter().with_min_len(PAR_MIN).map(|&x| half::f16::from_f32(x)).collect(),
        }
    }

    /// Values `range` as float32 (a copy).
    pub(crate) fn range_f32(&self, range: std::ops::Range<usize>) -> Vec<f32> {
        match self {
            Data::F32(v) => v[range].to_vec(),
            // loop: HOT-PATH-OK — carry hints: one small aux plane per frame the next window takes
            Data::F16(v) => v[range].iter().map(|x| x.to_f32()).collect(),
            // loop: NOT-WORTH — never used on a hot path (bf16 data is only an input)
            Data::Bf16(parts) => parts.iter().flat_map(|p| p.iter()).skip(range.start).take(range.len()).map(|x| x.to_f32()).collect(),
            Data::F32Ref(v) => v[range].to_vec(),
            // loop: NOT-WORTH — borrowed inputs only (never an output)
            Data::F16Ref(v) => v[range].iter().map(|x| x.to_f32()).collect(),
        }
    }
}

/// The concatenated `parts` through `f`, written straight into one vector (each part in parallel).
fn concat_parts<T: Send>(parts: &[&[half::bf16]], f: impl Fn(half::bf16) -> T + Sync + Send) -> Vec<T> {
    use rayon::prelude::*;
    // loop: NOT-WORTH — ≤ 80 slices
    let mut out = Vec::with_capacity(parts.iter().map(|p| p.len()).sum());
    // loop: HOT-PATH-OK — the window's frames (≤ 80); each frame converted in parallel chunks
    for p in parts {
        // loop: HOT-PATH-OK — each frame converted bf16 -> f16 / f32 straight into the input tensor, parallel
        out.par_extend(p.par_iter().with_min_len(PAR_MIN).map(|&x| f(x)));
    }
    out
}

/// An input: name, shape, data.
pub type Input<'a> = (&'a str, Vec<usize>, Data<'a>);

impl Net {
    pub(crate) fn load(rt: &Runtime, piece: &'static str, prov: Provider, file: &Path, vram_cap: Option<u64>) -> Result<Net, Error> {
        let session = rt.session(prov, file, vram_cap).map_err(|e| Error::ort(&format!("loading {}", file.display()), e))?;
        let f16_inputs =
            // loop: NOT-WORTH — ≤ six inputs, once per session load
            session.inputs().iter().filter(|i| i.dtype().tensor_type() == Some(ort::value::TensorElementType::Float16)).map(|i| i.name().to_string()).collect();
        // on the GPU a run can give its arena's working memory back (the five sessions have one arena each, so
        // without this their peaks would add up); the pipeline decides per phase, see `shrinks`
        let shrink_options = if matches!(prov, Provider::Cuda | Provider::TensorRt) {
            let mut o = ort::session::RunOptions::new().map_err(|e| Error::ort(piece, e))?;
            o.set("memory.enable_memory_arena_shrinkage", "gpu:0").map_err(|e| Error::ort(piece, e))?;
            Some(o)
        } else {
            None
        };
        Ok(Net {
            piece,
            session,
            provider: prov,
            f16_inputs,
            shrink_options,
            shrink: false,
            counters: NetCounters::default(),
            profiling: rt.cfg.profile.is_some(),
        })
    }

    /// Whether the graph takes input `name` as float16.
    pub(crate) fn wants_f16(&self, name: &str) -> bool {
        self.f16_inputs.iter().any(|n| n == name)
    }

    /// Run; each input is converted (once) to the type the graph takes. Outputs in the graph's output order as
    /// (shape, data) in the type the graph made them (float32 or float16), not converted.
    pub(crate) fn run(&mut self, inputs: Vec<Input<'_>>) -> Result<Vec<(Vec<usize>, Data<'static>)>, Error> {
        let t0 = std::time::Instant::now();
        let mut feed: Vec<(std::borrow::Cow<'_, str>, ort::session::SessionInputValue<'_>)> = Vec::with_capacity(inputs.len());
        // loop: NOT-WORTH — at most six inputs
        for (name, shape, data) in inputs {
            let v: ort::session::SessionInputValue<'_> = match (self.wants_f16(name), data) {
                // borrowed data already in the graph's type: a view, no copy
                (true, Data::F16Ref(s)) => TensorRef::from_array_view((shape, s)).map_err(|e| Error::ort(self.piece, e))?.into(),
                (false, Data::F32Ref(s)) => TensorRef::from_array_view((shape, s)).map_err(|e| Error::ort(self.piece, e))?.into(),
                (true, data) => Tensor::from_array((shape, data.into_f16())).map_err(|e| Error::ort(self.piece, e))?.into(),
                (false, data) => Tensor::from_array((shape, data.into_f32())).map_err(|e| Error::ort(self.piece, e))?.into(),
            };
            feed.push((std::borrow::Cow::Borrowed(name), v));
        }
        let piece = self.piece;
        let t1 = std::time::Instant::now();
        let outs = match (&self.shrink_options, self.shrink) {
            (Some(o), true) => self.session.run_with_options(feed, o),
            _ => self.session.run(feed),
        }
        .map_err(|e| Error::ort(piece, e))?;
        let t2 = std::time::Instant::now();
        let mut res = Vec::new();
        // loop: NOT-WORTH — one or two outputs
        for (_, v) in outs.iter() {
            if let Ok((s, d)) = v.try_extract_tensor::<f32>() {
                // loop: HOT-PATH-OK — the output's shape (≤ 5 dims) + one copy out of ORT's buffer (the session's outputs are freed right after)
                res.push((s.iter().map(|&x| x as usize).collect(), Data::F32(d.to_vec())));
            } else {
                let (s, d) = v.try_extract_tensor::<half::f16>().map_err(|e| Error::ort(piece, e))?;
                // loop: HOT-PATH-OK — the output's shape (≤ 5 dims) + one copy out of ORT's buffer, kept as float16
                res.push((s.iter().map(|&x| x as usize).collect(), Data::F16(d.to_vec())));
            }
        }
        drop(outs);
        let c = &mut self.counters;
        c.calls += 1;
        c.first_s.get_or_insert((t2 - t1).as_secs_f64());
        c.run_s += (t2 - t1).as_secs_f64();
        c.convert_s += (t1 - t0).as_secs_f64() + t2.elapsed().as_secs_f64();
        Ok(res)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arena_shrink_setting() {
        let l = ArenaShrink::List(vec!["rvm".into(), "stage1".into()]);
        assert!(shrinks("stage1", &ArenaShrink::Auto, true) && shrinks("stage2", &ArenaShrink::Auto, true));
        assert!(!shrinks("stage2", &ArenaShrink::Auto, false) && !shrinks("rvm", &ArenaShrink::Auto, false));
        assert!(shrinks("stage2", &ArenaShrink::All, false) && !shrinks("stage1", &ArenaShrink::None, true));
        assert!(shrinks("rvm", &l, false) && !shrinks("moge", &l, true));
    }

    #[test]
    fn version_from_build_info() {
        assert_eq!(ort_version("ORT Build Info: git-branch=rel-1.31.0, git-commit-id=402979a, build type=Release"), "1.31.0");
    }

    #[test]
    fn coreml_set_files_by_size_and_batch() {
        let dir = std::env::temp_dir().join(format!("ck-coreml-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let m = ModelSet::open(&dir).unwrap();
        assert!(m.coreml_file("stage1", (1152, 1280), 4).unwrap_err().contains("no Core ML model set"));
        std::fs::write(dir.join("s1-t4.onnx"), b"").unwrap();
        std::fs::write(
            dir.join("coreml.json"),
            r#"{"format": 1, "source_set": "2.0.0-onnx.3", "fp16": {"1152x1280": {"stage1-t4": "s1-t4.onnx", "stage1-t8": "gone.onnx", "rvm-t1": "x.onnx"}}}"#,
        )
        .unwrap();
        let m = ModelSet::open(&dir).unwrap();
        assert_eq!(m.coreml_file("stage1", (1152, 1280), 4), Ok(dir.join("s1-t4.onnx")));
        assert_eq!(m.coreml_batches("stage1", (1152, 1280)), vec![4, 8]);
        assert!(m.coreml_file("stage1", (1152, 1280), 8).unwrap_err().contains("missing"));
        let e = m.coreml_file("stage1", (1152, 1280), 6).unwrap_err();
        assert!(e.contains("6 frame(s)") && e.contains("4, 8 frame(s)"), "{e}");
        assert!(m.coreml_file("stage1", (2176, 4096), 4).unwrap_err().contains("it has 1152x1280"));
        // built from another model set: its weights don't match
        std::fs::write(dir.join("manifest.json"), r#"{"version": "2.0.0-onnx.4"}"#).unwrap();
        let m = ModelSet::open(&dir).unwrap();
        assert!(m.coreml_file("stage1", (1152, 1280), 4).unwrap_err().contains("built from model set 2.0.0-onnx.3"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn model_files_by_manifest_or_default_name() {
        let dir = std::env::temp_dir().join(format!("ck-models-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // loop: NOT-WORTH — a few empty files
        for f in ["stage1_op23fp16.onnx", "stage2_fp16.onnx", "stage2_op23fp16.onnx", "rvm_op23.onnx", "custom.onnx"] {
            std::fs::write(dir.join(f), b"").unwrap();
        }
        let m = ModelSet::open(&dir).unwrap();
        assert_eq!(m.file("stage1", Precision::Fp16), Some(dir.join("stage1_op23fp16.onnx")));
        assert_eq!(m.file("stage2", Precision::Fp16), Some(dir.join("stage2_fp16.onnx"))); // the plain name first
        assert_eq!(m.file("rvm", Precision::Fp32), Some(dir.join("rvm_op23.onnx")));
        assert_eq!(m.missing(Precision::Fp16), vec!["cradio", "moge", "rvm"]);
        std::fs::write(
            dir.join("models.json"),
            r#"{"fp16": {"rvm": "custom.onnx", "moge": "gone.onnx"}, "tensorrt-fp16": {"rvm": "stage2_fp16.onnx", "moge": "gone.onnx"}}"#,
        )
        .unwrap();
        let m = ModelSet::open(&dir).unwrap();
        assert_eq!(m.file("rvm", Precision::Fp16), Some(dir.join("custom.onnx")));
        assert_eq!(m.file("moge", Precision::Fp16), None);
        assert_eq!(m.trt_file("rvm", Precision::Fp16), Some(dir.join("stage2_fp16.onnx")));
        assert_eq!((m.trt_file("moge", Precision::Fp16), m.trt_file("rvm", Precision::Fp32)), (None, None));
        assert!(m.assets(Precision::Fp16)["stage1"]);
        // portrait: refused only for the sets whose C-RADIO was measured to fail on it
        assert!(m.version.is_none() && m.takes_portrait());
        // loop: NOT-WORTH — three versions
        for (v, ok) in [("2.0.0-onnx.2", false), ("2.0.0-onnx.1", false), ("2.0.0-onnx.3", true)] {
            std::fs::write(dir.join("manifest.json"), format!(r#"{{"format": "corridorkey-onnx-models/1", "version": "{v}"}}"#)).unwrap();
            let m = ModelSet::open(&dir).unwrap();
            assert_eq!((m.version.as_deref(), m.takes_portrait()), (Some(v), ok));
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
