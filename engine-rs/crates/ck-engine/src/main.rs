//! corridorkey-engine: CorridorKey on ONNX Runtime, speaking docs/ENGINE_PROTOCOL.md over stdio.
//!
//!   corridorkey-engine --models DIR [--ort libonnxruntime.so] [--device auto|cuda|cpu]
//!
//! --models (CK_ENGINE_MODELS): the folder with the five ONNX networks (docs/ENGINE_RUST.md).
//! --ort (CK_ENGINE_ORT, ORT_DYLIB_PATH): ONNX Runtime's library, for the GPU build that loads it at run time.
//! --device (CK_ENGINE_DEVICE): auto = the graphics card (no card: jobs fail with `no-gpu`, as the
//!   PyTorch engine); cpu = ONNX Runtime's CPU provider (tests; slow).
use ck_core::job::JobConfig;
use ck_core::pipeline::{JobResult, Pipeline, Sink};
use ck_core::runtime::{ModelSet, Runtime};
use ck_core::Error;
use ck_engine::{serve, Backend, Replies, ENGINE_VERSION, PROTOCOL};
use serde_json::{json, Value};
use std::path::PathBuf;

struct Ort {
    pipeline: Pipeline,
}

impl Backend for Ort {
    fn pong(&mut self) -> Value {
        let rt = self.pipeline.rt;
        let prov = rt.provider();
        let precision = prov.map(|p| rt.precision(p));
        json!({
            "type": "pong", "version": ENGINE_VERSION, "protocol": PROTOCOL, "engine": "onnxruntime",
            "device": if prov.is_some_and(|p| p != ck_core::runtime::Provider::Cpu) { "cuda" } else { "cpu" },
            "gpu": rt.gpu.as_ref().map(|g| g.name.clone()),
            "vram_total_mb": rt.gpu.as_ref().map(|g| g.total / 1048576),
            "provider": prov.map(|p| p.name()),
            "precision": precision.map(|p| p.name()),
            "tensorrt_available": rt.tensorrt_ep,
            "ort": rt.ort_version,
            "models_dir": self.pipeline.models.dir,
            "assets": precision.map(|p| json!(self.pipeline.models.assets(p))).unwrap_or(json!({})),
            "python": null, "torch": null
        })
    }
    fn run(&mut self, job: &JobConfig, sink: &mut dyn Sink) -> Result<JobResult, Error> {
        self.pipeline.run(job, sink)
    }
}

fn arg_value(args: &[String], name: &str) -> Option<String> {
    // loop: NOT-WORTH — the command line, once per process
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1).cloned()).or_else(|| {
        let p = format!("{name}=");
        // loop: NOT-WORTH — the command line, once per process
        args.iter().find_map(|a| a.strip_prefix(&p).map(|s| s.to_string()))
    })
}

/// Linux: end with the app. The engine runs a job to its end without reading stdin, in its own process group
/// (the app kills that group to cancel), so when the app itself died it kept the graphics card busy for a
/// whole job nobody would see (measured: an idle engine outlived its parent; tests/lifetime.rs). The kernel
/// now kills it when its parent goes; its ffmpeg children end with their pipes, and the app removes stale job
/// folders when it starts.
#[cfg(target_os = "linux")]
fn die_with_parent() {
    extern "C" {
        fn prctl(option: std::os::raw::c_int, arg2: std::os::raw::c_ulong, ...) -> std::os::raw::c_int;
        fn getppid() -> std::os::raw::c_int;
    }
    const PR_SET_PDEATHSIG: std::os::raw::c_int = 1;
    const SIGKILL: std::os::raw::c_ulong = 9;
    // SAFETY: prctl(2) PR_SET_PDEATHSIG with a signal number; getppid(2) has no arguments
    unsafe {
        let parent = getppid();
        prctl(PR_SET_PDEATHSIG, SIGKILL);
        // the parent went before the request took effect: nobody is listening
        if parent == 1 || getppid() != parent {
            std::process::exit(1);
        }
    }
}

fn main() {
    #[cfg(target_os = "linux")]
    die_with_parent();
    let args: Vec<String> = std::env::args().collect();
    // loop: NOT-WORTH — the command line, once per process
    if args.iter().any(|a| a == "--help" || a == "-h") {
        eprintln!("usage: corridorkey-engine --models DIR [--ort libonnxruntime.so] [--device auto|cuda|cpu]");
        return;
    }
    // loop: NOT-WORTH — the command line, once per process
    if args.iter().any(|a| a == "--version") {
        println!("corridorkey-engine {ENGINE_VERSION} (protocol {PROTOCOL})");
        return;
    }
    let mut out = Replies::new(std::io::stdout());
    let models = arg_value(&args, "--models").or_else(|| std::env::var("CK_ENGINE_MODELS").ok());
    let Some(models) = models else {
        out.send(json!({"type": "error", "code": "engine", "message": "engine failed to start: --models (or CK_ENGINE_MODELS) is required"}));
        std::process::exit(1);
    };
    let ort_lib = arg_value(&args, "--ort").map(PathBuf::from);
    let device = arg_value(&args, "--device").or_else(|| std::env::var("CK_ENGINE_DEVICE").ok()).unwrap_or_else(|| "auto".into());
    let rt = match Runtime::init(ort_lib.as_deref(), &device) {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("engine failed to start: {e}");
            out.send(json!({"type": "error", "code": "engine", "message": format!("engine failed to start: {e}")}));
            std::process::exit(1);
        }
    };
    let set = match ModelSet::open(&PathBuf::from(&models)) {
        Ok(s) => s,
        Err(e) => {
            out.send(json!({"type": "error", "code": "engine", "message": format!("engine failed to start: {e}")}));
            std::process::exit(1);
        }
    };
    eprintln!("corridorkey-engine {ENGINE_VERSION}: ONNX Runtime {}, provider {:?}, models {}", rt.ort_version, rt.provider().map(|p| p.name()), models);
    let mut backend = Ort { pipeline: Pipeline::new(rt, set) };
    serve(&mut backend, std::io::BufReader::new(std::io::stdin()), std::io::stdout());
}
