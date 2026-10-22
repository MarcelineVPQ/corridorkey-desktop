//! The one model-loading layer: ONNX Runtime, its execution provider (CUDA by default on an NVIDIA card,
//! TensorRT when a job opts in, the CPU only when asked for), and the five networks' files.
//!
//! Models folder (`--models DIR`): one ONNX file per network and precision, found by `models.json` when the
//! folder has one ({"fp16": {"stage1": "stage1_op23fp16.onnx", ...}, "fp32": {...}}), else by the first
//! existing default name (`<piece>_fp16.onnx`, the spike's `<piece>_op23fp16.onnx`, ...). External weights
//! (`.onnx.data`) sit next to their file.
use crate::gpu::{nvidia, GpuInfo};
use crate::Error;
use ort::session::builder::GraphOptimizationLevel;
use ort::session::Session;
use ort::value::Tensor;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub const PIECES: [&str; 5] = ["cradio", "moge", "rvm", "stage1", "stage2"];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Provider {
    Cuda,
    TensorRt,
    Cpu,
}

impl Provider {
    pub fn name(&self) -> &'static str {
        match self {
            Provider::Cuda => "cuda",
            Provider::TensorRt => "tensorrt",
            Provider::Cpu => "cpu",
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
    pub fn parse(s: &str) -> Option<Precision> {
        match s {
            "fp16" => Some(Precision::Fp16),
            "fp32" => Some(Precision::Fp32),
            _ => None,
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
}

/// A model's size on disk: the .onnx file and its external weights (.onnx.data) next to it.
pub fn model_bytes(file: &Path) -> u64 {
    let data = PathBuf::from(format!("{}.data", file.display()));
    [file.to_path_buf(), data].iter().filter_map(|p| std::fs::metadata(p).ok()).map(|m| m.len()).sum()
}

impl ModelSet {
    pub fn open(dir: &Path) -> Result<ModelSet, String> {
        let mpath = dir.join("models.json");
        let manifest = if mpath.exists() {
            let s = std::fs::read_to_string(&mpath).map_err(|e| format!("{}: {e}", mpath.display()))?;
            serde_json::from_str(&s).map_err(|e| format!("{}: {e}", mpath.display()))?
        } else {
            BTreeMap::new()
        };
        Ok(ModelSet { dir: dir.to_path_buf(), manifest })
    }

    /// The file of `piece` at `p`, if there is one.
    pub fn file(&self, piece: &str, p: Precision) -> Option<PathBuf> {
        if let Some(name) = self.manifest.get(p.name()).and_then(|m| m.get(piece)) {
            let f = self.dir.join(name);
            return f.exists().then_some(f);
        }
        default_names(piece, p).into_iter().map(|n| self.dir.join(n)).find(|f| f.exists())
    }

    /// Which networks are there at `p` (the pong's "assets").
    pub fn assets(&self, p: Precision) -> BTreeMap<String, bool> {
        PIECES.iter().map(|k| (k.to_string(), self.file(k, p).is_some())).collect()
    }

    pub fn missing(&self, p: Precision) -> Vec<String> {
        PIECES.iter().filter(|k| self.file(k, p).is_none()).map(|k| k.to_string()).collect()
    }
}

/// "1.31.0" from ORT's build info ("... git-branch=rel-1.31.0, ...").
pub fn ort_version(info: &str) -> String {
    info.split(|c: char| c == ',' || c.is_whitespace()).find_map(|t| t.strip_prefix("git-branch=rel-")).unwrap_or(info).to_string()
}

/// The version a libonnxruntime reports (OrtGetApiBase()->GetVersionString), e.g. "1.31.0".
pub fn dylib_version(lib: &Path) -> Option<String> {
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
    pub cuda_ep: bool,
    pub tensorrt_ep: bool,
    pub ort_version: String,
    /// asked for with --device / CK_ENGINE_DEVICE: auto | cuda | cpu
    pub want: String,
    pub threads: usize,
}

static GLOBAL: std::sync::OnceLock<Result<Runtime, String>> = std::sync::OnceLock::new();

impl Runtime {
    /// The process's runtime (one ORT environment per process). `ort_lib`: libonnxruntime.so for a
    /// load-dynamic build (else CK_ENGINE_ORT / ORT_DYLIB_PATH).
    pub fn init(ort_lib: Option<&Path>, want: &str) -> Result<&'static Runtime, String> {
        GLOBAL.get_or_init(|| Runtime::new(ort_lib, want)).as_ref().map_err(|e| e.clone())
    }

    pub fn get() -> Option<&'static Runtime> {
        GLOBAL.get().and_then(|r| r.as_ref().ok())
    }

    fn new(ort_lib: Option<&Path>, want: &str) -> Result<Runtime, String> {
        #[allow(unused_mut, unused_assignments)]
        let mut version: Option<String> = None;
        #[cfg(feature = "ort-dynamic")]
        let builder = {
            let lib = ort_lib
                .map(|p| p.to_string_lossy().into_owned())
                .or_else(|| std::env::var("CK_ENGINE_ORT").ok())
                .or_else(|| std::env::var("ORT_DYLIB_PATH").ok())
                .ok_or_else(|| "this build loads ONNX Runtime at run time: pass --ort (or CK_ENGINE_ORT) with libonnxruntime.so".to_string())?;
            version = dylib_version(Path::new(&lib));
            ort::init_from(&lib).map_err(|e| format!("{lib}: {e}"))?
        };
        #[cfg(not(feature = "ort-dynamic"))]
        let builder = {
            let _ = ort_lib;
            ort::init()
        };
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
        let gpu = if want == "cpu" { None } else { nvidia() };
        let threads = std::env::var("CK_ENGINE_THREADS").ok().and_then(|v| v.trim().parse().ok()).unwrap_or(0);
        Ok(Runtime { env, gpu, cuda_ep, tensorrt_ep, ort_version: version, want: want.to_string(), threads })
    }

    /// The normal provider: CUDA with a card and the CUDA EP (or when asked), the CPU only when asked.
    /// None: no usable GPU (the protocol's `no-gpu`).
    pub fn provider(&self) -> Option<Provider> {
        match self.want.as_str() {
            "cpu" => Some(Provider::Cpu),
            _ if self.gpu.is_some() && self.cuda_ep => Some(Provider::Cuda),
            _ => None,
        }
    }

    /// fp16 on the GPU, fp32 on the CPU; CK_ENGINE_PRECISION overrides.
    pub fn precision(&self, prov: Provider) -> Precision {
        match std::env::var("CK_ENGINE_PRECISION").ok().as_deref().and_then(Precision::parse) {
            Some(p) => p,
            None if prov == Provider::Cpu => Precision::Fp32,
            None => Precision::Fp16,
        }
    }

    fn builder(&self) -> Result<ort::session::builder::SessionBuilder, String> {
        let mut b = Session::builder(&self.env).map_err(|e| e.to_string())?;
        b = b.with_optimization_level(GraphOptimizationLevel::Level3).map_err(|e| e.to_string())?;
        if self.threads > 0 {
            b = b.with_intra_threads(self.threads).map_err(|e| e.to_string())?;
        }
        Ok(b)
    }

    /// A session for `file` on `prov`. TensorRT: `trt` gives the cache folder and the profile shapes.
    /// `vram_cap`: the most graphics memory (bytes) the session's CUDA arena may hold (gpu_mem_limit), and
    /// TensorRT's workspace limit.
    pub fn session(&self, prov: Provider, file: &Path, trt: Option<&TrtSettings>, vram_cap: Option<u64>) -> Result<Session, String> {
        let _ = vram_cap;
        let mut b = self.builder()?;
        // CK_ENGINE_PROFILE=<folder>: ONNX Runtime's per-node profile of each session (a measurement knob)
        if let Ok(dir) = std::env::var("CK_ENGINE_PROFILE") {
            let stem = file.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
            b = b.with_profiling(Path::new(&dir).join(stem)).map_err(|e| e.to_string())?;
        }
        match prov {
            Provider::Cpu => {}
            Provider::Cuda => {
                #[cfg(feature = "cuda")]
                {
                    b = b.with_execution_providers([cuda_ep(vram_cap).build().error_on_failure()]).map_err(|e| e.to_string())?;
                }
                #[cfg(not(feature = "cuda"))]
                return Err("this engine was built without the CUDA execution provider".into());
            }
            Provider::TensorRt => {
                #[cfg(feature = "tensorrt")]
                {
                    let t = trt.ok_or("TensorRT needs its cache settings")?;
                    std::fs::create_dir_all(&t.cache).map_err(|e| format!("{}: {e}", t.cache.display()))?;
                    use ort::ep::ArbitrarilyConfigurableExecutionProvider;
                    let mut ep = ort::ep::TensorRT::default()
                        .with_device_id(0)
                        .with_fp16(t.fp16)
                        .with_bf16(t.bf16)
                        .with_engine_cache(true)
                        .with_engine_cache_path(t.cache.to_string_lossy())
                        .with_timing_cache(true)
                        .with_timing_cache_path(t.cache.to_string_lossy())
                        .with_profile_min_shapes(&t.min)
                        .with_profile_opt_shapes(&t.opt)
                        .with_profile_max_shapes(&t.max);
                    if let Some(cap) = vram_cap {
                        ep = ep.with_max_workspace_size(cap as usize);
                    }
                    if !t.exclude.is_empty() {
                        // these node types stay on the CUDA provider (TensorRT's ONNX parser can't take them)
                        ep = ep.with_arbitrary_config("trt_op_types_to_exclude", &t.exclude);
                    }
                    b = b.with_execution_providers([ep.build().error_on_failure(), cuda_ep(vram_cap).build()]).map_err(|e| e.to_string())?;
                }
                #[cfg(not(feature = "tensorrt"))]
                {
                    let _ = trt;
                    return Err("this engine was built without the TensorRT execution provider".into());
                }
            }
        }
        b.commit_from_file(file).map_err(|e| e.to_string())
    }
}

#[cfg(feature = "cuda")]
fn cuda_ep(vram_cap: Option<u64>) -> ort::ep::CUDA {
    let mut ep = ort::ep::CUDA::default();
    if let Some(c) = vram_cap {
        ep = ep.with_memory_limit(c as usize);
    }
    // cuDNN's convolution algorithm search and workspace (ORT's defaults: exhaustive, as much workspace as it
    // wants): CK_ENGINE_CUDNN_SEARCH = exhaustive | heuristic | default, CK_ENGINE_CUDNN_MAX_WORKSPACE = 0 | 1
    match std::env::var("CK_ENGINE_CUDNN_SEARCH").as_deref() {
        Ok("heuristic") => ep = ep.with_conv_algorithm_search(ort::ep::cuda::ConvAlgorithmSearch::Heuristic),
        Ok("default") => ep = ep.with_conv_algorithm_search(ort::ep::cuda::ConvAlgorithmSearch::Default),
        _ => {}
    }
    if let Ok(v) = std::env::var("CK_ENGINE_CUDNN_MAX_WORKSPACE") {
        ep = ep.with_conv_max_workspace(v != "0");
    }
    ep.with_device_id(0)
        // the arena grows by what is asked: less held graphics memory
        .with_arena_extend_strategy(ort::ep::ArenaExtendStrategy::SameAsRequested)
        // TF32 off: an fp32 model on CUDA computes in fp32
        .with_tf32(false)
}

/// What a TensorRT session is built for.
#[derive(Clone, Debug, PartialEq)]
pub struct TrtSettings {
    pub cache: PathBuf,
    pub fp16: bool,
    pub bf16: bool,
    pub min: String,
    pub opt: String,
    pub max: String,
    /// op types left to the CUDA provider ("Attention": TensorRT 10.16 builds the opset-23 Attention op only in
    /// a strongly typed network, which ORT's TensorRT provider does not make)
    pub exclude: String,
}

/// CK_ENGINE_TRT_EXCLUDE, else "Attention".
pub fn trt_exclude() -> String {
    std::env::var("CK_ENGINE_TRT_EXCLUDE").unwrap_or_else(|_| "Attention".into())
}

/// A loaded network: its session and how its inputs want to be fed.
pub struct Net {
    pub piece: &'static str,
    // (end_profiling on drop when CK_ENGINE_PROFILE is set)
    pub session: Session,
    pub provider: Provider,
    pub precision: Precision,
    pub file: PathBuf,
    f16_inputs: Vec<String>,
    run_options: Option<ort::session::RunOptions>,
    /// measured: seconds in session.run, seconds converting inputs/outputs, calls (reset per job)
    pub run_s: f64,
    pub convert_s: f64,
    pub calls: usize,
}

impl Drop for Net {
    fn drop(&mut self) {
        if std::env::var("CK_ENGINE_PROFILE").is_ok() {
            if let Ok(f) = self.session.end_profiling() {
                eprintln!("  profile of {}: {f}", self.piece);
            }
        }
    }
}

/// Whether `piece`'s arena gives its working memory back after each run. CK_ENGINE_ARENA_SHRINK: "all" / "1",
/// "0" / "none", or a comma list of networks; default: all (measured: without it stage 2's arena can't fit its
/// 5.77 GB ConvTranspose buffer at 1280x1152 next to the others, docs/ENGINE_RUST.md).
pub fn shrinks(piece: &str, setting: Option<&str>) -> bool {
    match setting.map(|s| s.trim()) {
        Some("all") | Some("1") => true,
        Some("0") | Some("none") => false,
        Some(list) if !list.is_empty() => list.split(',').any(|p| p.trim() == piece),
        _ => true,
    }
}

/// A float32 input: name, shape, data.
pub type Input<'a> = (&'a str, Vec<usize>, Vec<f32>);

impl Net {
    pub fn load(
        rt: &Runtime,
        piece: &'static str,
        prov: Provider,
        precision: Precision,
        file: &Path,
        trt: Option<&TrtSettings>,
        vram_cap: Option<u64>,
    ) -> Result<Net, Error> {
        let session = rt.session(prov, file, trt, vram_cap).map_err(|e| Error::ort(&format!("loading {}", file.display()), e))?;
        let f16_inputs =
            session.inputs().iter().filter(|i| i.dtype().tensor_type() == Some(ort::value::TensorElementType::Float16)).map(|i| i.name().to_string()).collect();
        // on the GPU a run can give its arena's working memory back (the five sessions have one arena each, so
        // without this their peaks would add up); see `shrinks`
        let shrink = prov != Provider::Cpu && shrinks(piece, std::env::var("CK_ENGINE_ARENA_SHRINK").ok().as_deref());
        let run_options = if shrink {
            let mut o = ort::session::RunOptions::new().map_err(|e| Error::ort(piece, e))?;
            o.set("memory.enable_memory_arena_shrinkage", "gpu:0").map_err(|e| Error::ort(piece, e))?;
            Some(o)
        } else {
            None
        };
        Ok(Net { piece, session, provider: prov, precision, file: file.to_path_buf(), f16_inputs, run_options, run_s: 0.0, convert_s: 0.0, calls: 0 })
    }

    /// Run with float32 inputs (converted to float16 where the graph wants it); outputs as float32 in the
    /// graph's output order: (shape, data).
    pub fn run(&mut self, inputs: Vec<Input<'_>>) -> Result<Vec<(Vec<usize>, Vec<f32>)>, Error> {
        let t0 = std::time::Instant::now();
        let mut feed: Vec<(std::borrow::Cow<'_, str>, ort::session::SessionInputValue<'_>)> = Vec::with_capacity(inputs.len());
        // loop: NOT-WORTH — at most six inputs
        for (name, shape, data) in inputs {
            let v: ort::session::SessionInputValue<'_> = if self.f16_inputs.iter().any(|n| n == name) {
                use rayon::prelude::*;
                let h: Vec<half::f16> = data.par_iter().with_min_len(1 << 14).map(|&x| half::f16::from_f32(x)).collect();
                Tensor::from_array((shape, h)).map_err(|e| Error::ort(self.piece, e))?.into()
            } else {
                Tensor::from_array((shape, data)).map_err(|e| Error::ort(self.piece, e))?.into()
            };
            feed.push((std::borrow::Cow::Borrowed(name), v));
        }
        let piece = self.piece;
        let t1 = std::time::Instant::now();
        let outs = match &self.run_options {
            Some(o) => self.session.run_with_options(feed, o),
            None => self.session.run(feed),
        }
        .map_err(|e| Error::ort(piece, e))?;
        let t2 = std::time::Instant::now();
        let mut res = Vec::new();
        // loop: NOT-WORTH — one or two outputs
        for (_, v) in outs.iter() {
            if let Ok((s, d)) = v.try_extract_tensor::<f32>() {
                res.push((s.iter().map(|&x| x as usize).collect(), d.to_vec()));
            } else {
                let (s, d) = v.try_extract_tensor::<half::f16>().map_err(|e| Error::ort(piece, e))?;
                use rayon::prelude::*;
                res.push((s.iter().map(|&x| x as usize).collect(), d.par_iter().with_min_len(1 << 14).map(|x| x.to_f32()).collect()));
            }
        }
        drop(outs);
        self.calls += 1;
        self.run_s += (t2 - t1).as_secs_f64();
        self.convert_s += (t1 - t0).as_secs_f64() + t2.elapsed().as_secs_f64();
        Ok(res)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arena_shrink_setting() {
        assert!(shrinks("stage1", None) && shrinks("stage2", None));
        assert!(shrinks("stage2", Some("all")) && !shrinks("stage1", Some("0")));
        assert!(shrinks("rvm", Some("rvm,stage1")) && !shrinks("moge", Some("rvm,stage1")));
    }

    #[test]
    fn version_from_build_info() {
        assert_eq!(ort_version("ORT Build Info: git-branch=rel-1.31.0, git-commit-id=402979a, build type=Release"), "1.31.0");
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
        std::fs::write(dir.join("models.json"), r#"{"fp16": {"rvm": "custom.onnx", "moge": "gone.onnx"}}"#).unwrap();
        let m = ModelSet::open(&dir).unwrap();
        assert_eq!(m.file("rvm", Precision::Fp16), Some(dir.join("custom.onnx")));
        assert_eq!(m.file("moge", Precision::Fp16), None);
        assert_eq!(m.assets(Precision::Fp16)["stage1"], true);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
