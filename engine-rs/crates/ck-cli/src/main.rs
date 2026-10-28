//! corridorkey: CorridorKey on the command line, for render farms and power users (docs/CLI.md).
//!
//!   corridorkey render -i plates/sh010.####.exr -o key/sh010_key.####.exr -F 1001-1100
//!   corridorkey verify | prepare | info | help
//!
//! It links ck-core directly. Unlike the engine (corridorkey-engine) it has no parent-death watch: a farm's launcher
//! may be PID 1, or exit before its task; SIGTERM / SIGINT stop it cleanly (exit 143 / 130). On Windows its children
//! (the TensorRT builder, `run`'s app, ffmpeg) end with it (ck_core::proc::children_end_with_me).
fn main() {
    no_dlls_from_current_folder();
    ck_core::proc::children_end_with_me();
    std::process::exit(ck_cli::run::main(std::env::args_os().collect()));
}

/// Windows: a DLL loaded by bare name (ONNX Runtime's providers load cudart, cuDNN and TensorRT that way) is
/// otherwise looked for in the current folder before PATH, and the current folder is wherever the farm or the app's
/// Console started this (a client's drive, Downloads). An empty SetDllDirectoryW takes the current folder out of the
/// search order; the exe's folder, System32 and PATH stay (senior review of the Console 2026-10-26, S6).
#[cfg(windows)]
fn no_dlls_from_current_folder() {
    #[link(name = "kernel32")]
    extern "system" {
        fn SetDllDirectoryW(path: *const u16) -> i32;
    }
    let empty: [u16; 1] = [0];
    // SAFETY: a documented kernel32 call with a NUL-terminated (empty) wide string that outlives the call
    unsafe {
        SetDllDirectoryW(empty.as_ptr());
    }
}

#[cfg(not(windows))]
fn no_dlls_from_current_folder() {}
