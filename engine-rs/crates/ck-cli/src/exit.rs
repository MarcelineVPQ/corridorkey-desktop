//! The exit codes (docs/CLI.md "Exit codes"), the only place ck-core's error codes become them. Farms treat any
//! non-zero exit as a failure and retry; the code says whether a retry can help. Never 1 for anything specific, and
//! never 33 or 137 (OpenCue's retry codes).
use ck_core::ErrorCode;

pub const DONE: i32 = 0;
/// a usage error or a request the engine can't take (a bad flag, value, frame list or job file)
pub const USAGE: i32 = 2;
/// the clip, a hint or a frame can't be read
pub const INPUT: i32 = 3;
/// the results can't be written (not writable, disk full, files already there)
pub const OUTPUT: i32 = 4;
/// no usable graphics card (or Core ML provider)
pub const NO_GPU: i32 = 5;
/// the graphics card (or the host, on the CPU) ran out of memory
pub const OOM: i32 = 6;
/// the models, ONNX Runtime, ffmpeg or a library are missing
pub const ASSETS: i32 = 7;
/// anything else in the engine
pub const ENGINE: i32 = 8;
/// `verify`: a requested frame is missing or not a whole EXR
pub const INCOMPLETE: i32 = 9;
/// stopped by SIGINT (Ctrl+C) / SIGTERM (a farm's cancel), after a clean stop: 128 + the signal
pub const SIGINT: i32 = 130;
pub const SIGTERM: i32 = 143;

/// The exit code of a failed run. `stopped_by`: the signal that asked the run to stop, if one did: it wins, whatever
/// error the stop surfaced as (a Ctrl+C reaches the ffmpeg children too, and their end is a decode error).
pub fn for_error(code: ErrorCode, stopped_by: Option<i32>) -> i32 {
    if let Some(sig) = stopped_by {
        return if sig == 2 { SIGINT } else { SIGTERM };
    }
    match code {
        ErrorCode::BadRequest => USAGE,
        ErrorCode::Input => INPUT,
        ErrorCode::Output => OUTPUT,
        ErrorCode::NoGpu => NO_GPU,
        ErrorCode::Oom => OOM,
        ErrorCode::Assets => ASSETS,
        // a stop without a signal can't happen (only a signal asks for one): an engine error if it ever does
        ErrorCode::Engine | ErrorCode::Cancelled => ENGINE,
    }
}

/// The exit code's name (the report's `exit_reason`, the `openjd_fail:` line).
pub fn reason(exit: i32) -> &'static str {
    match exit {
        DONE => "done",
        USAGE => "usage",
        INPUT => "input",
        OUTPUT => "output",
        NO_GPU => "no-gpu",
        OOM => "out-of-graphics-memory",
        ASSETS => "assets",
        ENGINE => "engine",
        INCOMPLETE => "incomplete",
        SIGINT => "interrupted",
        SIGTERM => "terminated",
        _ => "unknown",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_error_code_has_its_exit_code() {
        let all = [
            (ErrorCode::BadRequest, 2),
            (ErrorCode::Input, 3),
            (ErrorCode::Output, 4),
            (ErrorCode::NoGpu, 5),
            (ErrorCode::Oom, 6),
            (ErrorCode::Assets, 7),
            (ErrorCode::Engine, 8),
            (ErrorCode::Cancelled, 8),
        ];
        // loop: NOT-WORTH — eight codes
        for (c, x) in all {
            assert_eq!(for_error(c, None), x, "{c}");
            assert!(![1, 33, 137].contains(&x));
        }
    }

    #[test]
    fn a_signal_wins_over_the_error_it_surfaced_as() {
        assert_eq!(for_error(ErrorCode::Cancelled, Some(15)), 143);
        assert_eq!(for_error(ErrorCode::Cancelled, Some(2)), 130);
        // Ctrl+C reached the ffmpeg decoder first: the job failed reading, but it was the user's stop
        assert_eq!(for_error(ErrorCode::Input, Some(2)), 130);
        assert_eq!(for_error(ErrorCode::Engine, Some(15)), 143);
    }

    #[test]
    fn reasons() {
        let names: Vec<&str> = [0, 2, 3, 4, 5, 6, 7, 8, 9, 130, 143].map(reason).to_vec();
        assert_eq!(
            names,
            ["done", "usage", "input", "output", "no-gpu", "out-of-graphics-memory", "assets", "engine", "incomplete", "interrupted", "terminated"]
        );
    }
}
