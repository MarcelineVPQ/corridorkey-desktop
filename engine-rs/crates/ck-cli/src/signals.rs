//! SIGTERM (a farm's cancel) and SIGINT (Ctrl+C) ask the run to stop after the current frame
//! (ck_core::pipeline::Sink::stop_requested); the run then removes its temporary files and exits 143 / 130. A second
//! signal while stopping ends the process at once (128 + the signal), as a shell user expects of a second Ctrl+C.
//! Windows: Ctrl+C is SIGINT; Ctrl+Break, closing the console, log-off and shut-down are SIGTERM (the last three give
//! the run at most 4.5 s to stop: the system ends the process after that).
use std::sync::atomic::{AtomicI32, Ordering};

/// The signal that asked for a stop (0: none yet).
static STOP: AtomicI32 = AtomicI32::new(0);

/// The signal that asked the run to stop, if one did (2 = SIGINT, 15 = SIGTERM).
pub fn stopped_by() -> Option<i32> {
    match STOP.load(Ordering::SeqCst) {
        0 => None,
        s => Some(s),
    }
}

/// What the handlers do with signal `sig`: the first asks for a stop; true when it is a second one (exit now).
fn on_signal(sig: i32) -> bool {
    STOP.compare_exchange(0, sig, Ordering::SeqCst, Ordering::SeqCst).is_err()
}

#[cfg(unix)]
mod sys {
    use std::os::raw::c_int;
    extern "C" {
        fn signal(sig: c_int, handler: usize) -> usize;
        fn _exit(code: c_int) -> !;
    }
    const SIGINT: c_int = 2;
    const SIGTERM: c_int = 15;

    extern "C" fn handler(sig: c_int) {
        // only an atomic store and _exit(2): both async-signal-safe
        if super::on_signal(sig) {
            // SAFETY: _exit is async-signal-safe and ends the process without running anything else
            unsafe { _exit(128 + sig) };
        }
    }

    pub(super) fn install() {
        // SAFETY: signal(2) with a handler that only stores an atomic or calls _exit (async-signal-safe); glibc and
        // macOS give it BSD semantics (stays installed, interrupted reads restart)
        unsafe {
            signal(SIGINT, handler as extern "C" fn(c_int) as usize);
            signal(SIGTERM, handler as extern "C" fn(c_int) as usize);
        }
    }
}

#[cfg(windows)]
mod sys {
    #[link(name = "kernel32")]
    extern "system" {
        fn SetConsoleCtrlHandler(handler: Option<unsafe extern "system" fn(u32) -> i32>, add: i32) -> i32;
        fn ExitProcess(code: u32) -> !;
    }
    const CTRL_C_EVENT: u32 = 0;
    const CTRL_BREAK_EVENT: u32 = 1;

    unsafe extern "system" fn handler(event: u32) -> i32 {
        let sig = if event == CTRL_C_EVENT { 2 } else { 15 };
        if super::on_signal(sig) {
            ExitProcess(128 + sig as u32);
        }
        // Ctrl+C / Ctrl+Break: handled, the run stops after its current frame. Closing the console, log-off and
        // shut-down end the process as soon as this handler returns (Microsoft's HandlerRoutine docs; the system
        // waits at most 5 s for a close, more for log-off and shut-down), so it waits here instead: the main thread
        // stops the run, removes its folders and exits 143, which ends this thread with the process (farm review S7)
        if event > CTRL_BREAK_EVENT {
            // loop: SERIAL-REQUIRED — the console's close waits for the run's own stop [bounded: 4.5 s, inside the 5 s]
            std::thread::sleep(std::time::Duration::from_millis(4500));
        }
        1
    }

    pub(super) fn install() {
        // SAFETY: a documented kernel32 call with a handler of the documented signature
        unsafe {
            SetConsoleCtrlHandler(Some(handler), 1);
        }
    }
}

/// Install the handlers (once, at the start of `render` and `prepare`).
pub fn install() {
    sys::install();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_first_signal_asks_for_a_stop_and_a_second_ends_it() {
        assert_eq!(stopped_by(), None);
        assert!(!on_signal(15), "the first signal asks for a stop");
        assert_eq!(stopped_by(), Some(15));
        assert!(on_signal(2), "a second one ends the process");
        assert_eq!(stopped_by(), Some(15), "the first signal names the stop");
        STOP.store(0, Ordering::SeqCst);
    }
}
