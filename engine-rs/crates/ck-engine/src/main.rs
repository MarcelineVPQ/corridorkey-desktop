//! corridorkey-engine: CorridorKey on ONNX Runtime, speaking docs/ENGINE_PROTOCOL.md over stdio.
//!
//!   corridorkey-engine --models DIR [--ort libonnxruntime.so] [--device auto|cuda|cpu|coreml|migraphx]
//!
//! --models (CK_ENGINE_MODELS): the folder with the five ONNX networks (docs/ENGINE_RUST.md).
//! --ort (CK_ENGINE_ORT, ORT_DYLIB_PATH): ONNX Runtime's library, for the GPU build that loads it at run time.
//! --device (CK_ENGINE_DEVICE): auto = the graphics card (no card: jobs fail with `no-gpu`, as the
//!   PyTorch engine); cpu = ONNX Runtime's CPU provider (tests; slow); coreml = ONNX Runtime's Core ML provider
//!   (macOS only; the models folder's Core ML set, coreml.json; docs/ENGINE_RUST.md); migraphx = ONNX Runtime's
//!   MIGraphX provider on an AMD card (Linux; `auto` picks it with ONNX Runtime's MIGraphX build; docs/AMD.md).
//! Every other setting is a CK_ENGINE_* variable (docs/ENGINE_RUST.md "Knobs"), read once (ck_core::config).
use ck_core::config::EngineConfig;
use ck_core::job::JobConfig;
use ck_core::pipeline::{JobResult, Pipeline, Sink};
use ck_core::runtime::{ModelSet, Runtime};
use ck_core::Error;
use ck_engine::{serve, Backend, Replies, ENGINE_VERSION, PROTOCOL};
use serde_json::{json, Value};

struct Ort {
    pipeline: Pipeline,
}

impl Backend for Ort {
    fn pong(&mut self) -> Value {
        let rt = self.pipeline.rt();
        let prov = rt.provider();
        let precision = prov.map(|p| rt.precision(p));
        json!({
            "type": "pong", "version": ENGINE_VERSION, "protocol": PROTOCOL, "engine": "onnxruntime",
            "device": match prov {
                Some(ck_core::runtime::Provider::CoreMl) => "coreml",
                Some(ck_core::runtime::Provider::Migraphx) => "migraphx",
                Some(p) if p != ck_core::runtime::Provider::Cpu => "cuda",
                _ => "cpu",
            },
            // (additive) the loaded ONNX Runtime has the Core ML provider; with --device coreml and without it,
            // `provider` is null and `unavailable` says why (nothing runs on the CPU instead)
            "coreml_available": rt.coreml_ep,
            "unavailable": if prov.is_none() { Some(rt.unavailable_reason()) } else { None },
            "gpu": rt.gpu.as_ref().map(|g| g.name.clone()),
            "vram_total_mb": rt.gpu.as_ref().map(|g| g.total / 1048576),
            "provider": prov.map(|p| p.name()),
            "precision": precision.map(|p| p.name()),
            "tensorrt_available": rt.tensorrt_ep,
            "ort": rt.ort_version,
            "models_dir": self.pipeline.models.dir,
            // the model set's version from its manifest.json (additive; null without one), for the job log
            "model_set": self.pipeline.models.version,
            "assets": precision.map(|p| json!(self.pipeline.models.assets(p))).unwrap_or(json!({})),
            "python": null, "torch": null,
            // the settings it runs with (additive): its command line and CK_ENGINE_* variables, as read at startup
            "config": rt.cfg.to_json(),
            // what reads the frames (additive): the JPEG decoder (libjpeg-turbo or the image crate), ffmpeg and ffprobe
            "decoders": ck_core::decode::Decoders::read(None).to_json(),
            // the linked OpenColorIO's version (additive; backlog row 29)
            "ocio": ck_core::ocio::version()
        })
    }
    fn run(&mut self, job: &JobConfig, sink: &mut dyn Sink) -> Result<JobResult, Error> {
        self.pipeline.run(job, sink)
    }
    fn reset(&mut self) {
        self.pipeline.reset();
    }
    // the reading the automatic window takes (pipeline/mod.rs): NVML (or the amdgpu driver) on a card, the host's free
    // memory on the CPU
    fn card_memory(&mut self) -> Option<ck_core::vram::CardMemory> {
        use ck_core::runtime::Provider;
        use ck_core::vram::CardMemory;
        match self.pipeline.rt().provider()? {
            Provider::CoreMl => None,
            Provider::Cpu => {
                let free = ck_core::gpu::host_available()?;
                Some(CardMemory { total: None, free, budget: free, source: "host", provider: Provider::Cpu.name() })
            }
            p => {
                // first: where the driver can't tell this process's memory, it drops the loaded networks (gpu_budget)
                let budget = self.pipeline.gpu_budget()?;
                let (total, free, _) = ck_core::gpu::card_memory()?;
                Some(CardMemory { total: Some(total), free, budget, source: "gpu", provider: p.name() })
            }
        }
    }
    fn vram_budget_gb(&self) -> Option<f64> {
        self.pipeline.rt().cfg.vram_budget_gb
    }
    fn trt_build(&mut self, width: usize, height: usize, frames: usize, vram_budget_gb: Option<f64>, sink: &mut dyn Sink) -> Result<Value, Error> {
        self.pipeline.trt_build(width, height, frames, vram_budget_gb, sink)
    }
}

fn main() {
    // Windows: no DLL from the current folder (turbojpeg, nvml, nvcuda, nvinfer and ONNX Runtime's providers load by
    // bare name), before anything loads one
    ck_core::proc::no_dlls_from_current_folder();
    // the environment ONNX Runtime reads itself, set while no other thread exists (config::set_process_env)
    ck_core::config::set_process_env();
    // end with the app on every system (ck_core::proc::end_with_parent). First thing, on the main thread, before any
    // other thread exists: on Linux the parent-death signal is armed for this process from here on, and the protocol
    // loop (`serve`) stays on this thread so the children it starts with proc::die_with_parent (the TensorRT
    // builder) die with it: PR_SET_PDEATHSIG follows the spawning thread, not the process. (Read here, before the
    // settings, so even a bad setting doesn't leave an engine without a parent.)
    ck_core::proc::end_with_parent(ck_core::proc::parent_pid_from(std::env::var("CK_ENGINE_PARENT_PID").ok().as_deref()));
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--help" || a == "-h") {
        eprintln!("usage: corridorkey-engine --models DIR [--ort libonnxruntime.so] [--device auto|cuda|cpu|coreml|migraphx]");
        return;
    }
    if args.iter().any(|a| a == "--version") {
        println!("corridorkey-engine {ENGINE_VERSION} (protocol {PROTOCOL})");
        return;
    }
    let mut out = Replies::new(std::io::stdout());
    // a stub OCIO (built without the `ocio` feature) does no colour work: such an engine never runs (backlog row 29)
    if let Err(e) = ck_core::ocio::require_real_ocio() {
        eprintln!("engine failed to start: {e}");
        out.send(json!({"type": "error", "code": "engine", "message": format!("engine failed to start: {e}")}));
        std::process::exit(1);
    }
    // every setting, once: the command line and CK_ENGINE_* (an unknown value stops the engine, saying which)
    let cfg = match EngineConfig::parse(&args, &|k| std::env::var(k).ok(), std::env::consts::OS) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("engine failed to start: {e}");
            out.send(json!({"type": "error", "code": "engine", "message": format!("engine failed to start: {e}")}));
            std::process::exit(1);
        }
    };
    eprintln!("corridorkey-engine {ENGINE_VERSION} settings: {}", cfg.to_json());
    let Some(models) = cfg.models.clone() else {
        out.send(json!({"type": "error", "code": "engine", "message": "engine failed to start: --models (or CK_ENGINE_MODELS) is required"}));
        std::process::exit(1);
    };
    let rt = match Runtime::init(&cfg) {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("engine failed to start: {}", e.message);
            out.send(json!({"type": "error", "code": "engine", "message": format!("engine failed to start: {}", e.message)}));
            std::process::exit(1);
        }
    };
    let set = match ModelSet::open(&models) {
        Ok(s) => s,
        Err(e) => {
            out.send(json!({"type": "error", "code": "engine", "message": format!("engine failed to start: {}", e.message)}));
            std::process::exit(1);
        }
    };
    eprintln!(
        "corridorkey-engine {ENGINE_VERSION}: ONNX Runtime {}, provider {:?}, models {}",
        rt.ort_version,
        rt.provider().map(|p| p.name()),
        models.display()
    );
    let mut backend = Ort { pipeline: Pipeline::new(rt, set) };
    serve(&mut backend, std::io::BufReader::new(std::io::stdin()), std::io::stdout());
}
