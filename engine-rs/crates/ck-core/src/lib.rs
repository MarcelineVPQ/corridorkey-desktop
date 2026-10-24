//! CorridorKey's inference pipeline on ONNX Runtime (docs/ENGINE_RUST.md): a port of the upstream runtime's
//! host side (corridorkey/runtime.py, video_io.py, color_utils.py) around the five exported networks
//! (C-RADIO, MoGe, RVM single step, stage 1, stage 2).
pub(crate) mod ahead;
pub mod clip;
pub mod color;
pub mod decode;
pub mod gpu;
pub mod hann;
pub mod image;
pub mod job;
pub(crate) mod outputs;
pub mod pipeline;
pub mod proc;
pub mod render;
pub mod runtime;
pub(crate) mod settings;
pub(crate) mod tensorrt;
pub mod vram;
pub mod writers;

/// A job failure with the protocol's error code (docs/ENGINE_PROTOCOL.md): oom, input, assets, no-gpu,
/// cancelled, engine.
#[derive(Clone, Debug, PartialEq)]
pub struct Error {
    pub code: &'static str,
    pub message: String,
}

impl Error {
    pub fn new(code: &'static str, message: String) -> Error {
        Error { code, message }
    }
    pub fn input(m: String) -> Error {
        Error::new("input", m)
    }
    pub fn assets(m: String) -> Error {
        Error::new("assets", m)
    }
    pub fn engine(m: String) -> Error {
        Error::new("engine", m)
    }
    pub fn oom(m: String) -> Error {
        Error::new("oom", m)
    }
    pub fn no_gpu(m: String) -> Error {
        Error::new("no-gpu", m)
    }
    /// An ONNX Runtime failure: "oom" when the provider says it ran out of memory, else "engine".
    pub fn ort(what: &str, e: impl std::fmt::Display) -> Error {
        let m = e.to_string();
        let low = m.to_lowercase();
        if low.contains("out of memory")
            || low.contains("failed to allocate")
            || low.contains("cudaerrormemoryallocation")
            || low.contains("bad_alloc")
            || low.contains("smaller than requested bytes")
        {
            Error::oom(format!("The graphics card ran out of memory ({what}): {}", first_line(&m)))
        } else {
            Error::engine(format!("{what}: {m}"))
        }
    }
}

fn first_line(s: &str) -> &str {
    // loop: NOT-WORTH — first line of an error message
    s.lines().next().unwrap_or(s)
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for Error {}
