//! CorridorKey's inference pipeline on ONNX Runtime (docs/ENGINE_RUST.md): a port of the upstream runtime's
//! host side (corridorkey/runtime.py, video_io.py, color_utils.py) around the five exported networks
//! (C-RADIO, MoGe, RVM single step, stage 1, stage 2).
pub(crate) mod ahead;
pub mod clip;
pub mod color;
pub mod config;
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

/// The protocol's error codes (docs/ENGINE_PROTOCOL.md); `as_str` is what goes on the wire.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ErrorCode {
    /// the graphics card (or the host, on the CPU provider) ran out of memory: the automatic window is halved
    Oom,
    /// the clip, a hint or an option can't be used
    Input,
    /// model files, ffmpeg or a library are missing
    Assets,
    NoGpu,
    Cancelled,
    /// the results can't be written: the output (or temporary) folder isn't writable, or its disk is full
    Output,
    /// anything else (a bug, an unexpected runtime failure)
    Engine,
    /// a request the engine can't take as it is
    BadRequest,
}

impl ErrorCode {
    pub fn as_str(&self) -> &'static str {
        match self {
            ErrorCode::Oom => "oom",
            ErrorCode::Input => "input",
            ErrorCode::Assets => "assets",
            ErrorCode::NoGpu => "no-gpu",
            ErrorCode::Cancelled => "cancelled",
            ErrorCode::Output => "output",
            ErrorCode::Engine => "engine",
            ErrorCode::BadRequest => "bad-request",
        }
    }
}

impl std::fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A job failure with the protocol's error code.
#[derive(Clone, Debug, PartialEq)]
pub struct Error {
    pub code: ErrorCode,
    pub message: String,
}

impl Error {
    pub fn new(code: ErrorCode, message: String) -> Error {
        Error { code, message }
    }
    pub fn input(m: String) -> Error {
        Error::new(ErrorCode::Input, m)
    }
    pub fn assets(m: String) -> Error {
        Error::new(ErrorCode::Assets, m)
    }
    pub fn engine(m: String) -> Error {
        Error::new(ErrorCode::Engine, m)
    }
    pub fn oom(m: String) -> Error {
        Error::new(ErrorCode::Oom, m)
    }
    pub fn no_gpu(m: String) -> Error {
        Error::new(ErrorCode::NoGpu, m)
    }
    /// A request the engine can't take as it is (a value outside its documented range, not a finite number).
    pub fn bad_request(m: String) -> Error {
        Error::new(ErrorCode::BadRequest, m)
    }
    /// An ONNX Runtime failure: `Oom` when the provider says it ran out of memory, else `Engine`.
    pub fn ort(what: &str, e: impl std::fmt::Display) -> Error {
        let m = e.to_string();
        if is_oom_message(&m) {
            Error::oom(format!("The graphics card ran out of memory ({what}): {}", first_line(&m)))
        } else {
            Error::engine(format!("{what}: {m}"))
        }
    }
    /// A file system failure while writing results or temporary files (`what`: "the output folder", "a temporary
    /// file"): `Output` with words when the folder isn't writable or its disk is full (no point retrying the job
    /// as it is), else `Engine`.
    pub fn write(what: &str, path: &std::path::Path, e: &std::io::Error) -> Error {
        match write_failure(e) {
            Some(why) => Error::new(ErrorCode::Output, format!("Can't write {what} {}: {why} ({e})", path.display())),
            None => Error::engine(format!("{}: {e}", path.display())),
        }
    }
}

/// The out-of-memory texts ONNX Runtime and its CUDA provider use (each one has a test).
const OOM_MESSAGES: [&str; 5] = ["out of memory", "failed to allocate", "cudaerrormemoryallocation", "bad_alloc", "smaller than requested bytes"];

/// Whether an ONNX Runtime / CUDA message says the memory ran out.
pub(crate) fn is_oom_message(m: &str) -> bool {
    let low = m.to_lowercase();
    // loop: NOT-WORTH — five markers over one error message
    OOM_MESSAGES.iter().any(|k| low.contains(k))
}

/// Why a write failed, in words, when it's the folder or the disk (not a bug): permission, read-only, full.
pub(crate) fn write_failure(e: &std::io::Error) -> Option<&'static str> {
    use std::io::ErrorKind as K;
    match e.kind() {
        K::PermissionDenied => return Some("not allowed to write there"),
        K::ReadOnlyFilesystem => return Some("the drive is read-only"),
        K::StorageFull | K::QuotaExceeded => return Some("the disk is full"),
        _ => {}
    }
    // ENOSPC / EDQUOT / EROFS (Linux, macOS) and ERROR_DISK_FULL / ERROR_HANDLE_DISK_FULL (Windows) when the kind is
    // not mapped
    write_failure_text(&e.to_string())
}

/// `write_failure` from a message's text (an io::Error's, or a line ffmpeg wrote to stderr).
pub(crate) fn write_failure_text(text: &str) -> Option<&'static str> {
    let text = text.to_lowercase();
    if text.contains("no space left") || text.contains("disk full") || text.contains("not enough space") || text.contains("quota") {
        Some("the disk is full")
    } else if text.contains("read-only file system") {
        Some("the drive is read-only")
    } else if text.contains("permission denied") || text.contains("access is denied") {
        Some("not allowed to write there")
    } else {
        None
    }
}

/// What a panic said (its payload is a String or a &str for panic!/unwrap/expect; anything else: "panic").
pub fn panic_message(p: &(dyn std::any::Any + Send)) -> String {
    p.downcast_ref::<String>().cloned().or_else(|| p.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_else(|| "panic".into())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_known_oom_message_is_oom() {
        // the texts as ONNX Runtime 1.31 and its CUDA provider write them (one per marker in OOM_MESSAGES)
        let cases = [
            "CUDA failure 2: out of memory ; GPU=0 ; hostname=x ; file=cuda_call.cc ; line=129",
            "[ONNXRuntimeError] : 6 : RUNTIME_EXCEPTION : Non-zero status code returned while running Conv node. Failed to allocate memory for requested buffer of size 805306368",
            "CUDA error cudaErrorMemoryAllocation:out of memory",
            "std::bad_alloc",
            "Available memory of 268435456 is smaller than requested bytes of 805306368",
        ];
        assert_eq!(cases.len(), OOM_MESSAGES.len());
        // loop: NOT-WORTH — five test messages
        for m in cases {
            let e = Error::ort("stage1", m);
            assert_eq!(e.code, ErrorCode::Oom, "{m}");
            assert!(e.message.starts_with("The graphics card ran out of memory (stage1)"), "{}", e.message);
        }
        let e = Error::ort("stage1", "Invalid input name: rgbx");
        assert_eq!((e.code, e.message.as_str()), (ErrorCode::Engine, "stage1: Invalid input name: rgbx"));
    }

    #[test]
    fn wire_codes_are_unchanged() {
        let all = [
            (ErrorCode::Oom, "oom"),
            (ErrorCode::Input, "input"),
            (ErrorCode::Assets, "assets"),
            (ErrorCode::NoGpu, "no-gpu"),
            (ErrorCode::Cancelled, "cancelled"),
            (ErrorCode::Output, "output"),
            (ErrorCode::Engine, "engine"),
            (ErrorCode::BadRequest, "bad-request"),
        ];
        // loop: NOT-WORTH — eight codes
        for (c, s) in all {
            assert_eq!((c.as_str(), c.to_string()), (s, s.to_string()));
        }
    }

    #[test]
    fn unwritable_or_full_is_output_with_words() {
        let p = std::path::Path::new("/o/shot_alpha.mp4");
        let e = Error::write("the output", p, &std::io::Error::from(std::io::ErrorKind::PermissionDenied));
        assert_eq!(e.code, ErrorCode::Output);
        assert!(e.message.contains("not allowed to write there"), "{}", e.message);
        #[cfg(unix)]
        {
            let full = Error::write("the output", p, &std::io::Error::from_raw_os_error(28));
            assert_eq!(full.code, ErrorCode::Output);
            assert!(full.message.contains("the disk is full"), "{}", full.message);
            let ro = Error::write("the output", p, &std::io::Error::from_raw_os_error(30));
            assert!(ro.message.contains("read-only"), "{}", ro.message);
        }
        let other = Error::write("the output", p, &std::io::Error::other("broken pipe"));
        assert_eq!(other.code, ErrorCode::Engine);
    }
}
