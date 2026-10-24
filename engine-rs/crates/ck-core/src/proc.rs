//! Child processes with a deadline: no wait in the engine is open-ended (a hung ffprobe, encoder or TensorRT
//! build would otherwise hold the job, and the graphics card, forever). Waiting is a poll of `try_wait` with a
//! sleep between checks (`POLL`), never a spin.
use std::io::Read;
use std::process::{Child, Command, ExitStatus, Output, Stdio};
use std::time::{Duration, Instant};

/// How often a deadline wait looks at the child.
pub const POLL: Duration = Duration::from_millis(50);

/// Wait for `child` until `timeout`; past it the child is killed and reaped, and `None` returned.
pub fn wait_timeout(child: &mut Child, timeout: Duration) -> std::io::Result<Option<ExitStatus>> {
    let end = Instant::now() + timeout;
    // loop: SERIAL-REQUIRED — one child; a poll every POLL ms [bounded: the deadline, then kill]
    loop {
        if let Some(st) = child.try_wait()? {
            return Ok(Some(st));
        }
        if Instant::now() >= end {
            let _ = child.kill();
            // loop: NOT-WORTH — reaps the child after kill() [bounded: a killed child exits]
            let _ = child.wait();
            return Ok(None);
        }
        // loop: SERIAL-REQUIRED — the deadline poll's 50 ms sleep (not a spin)
        std::thread::sleep(POLL);
    }
}

/// `cmd.output()` with a deadline: stdout and stderr are read on their own threads (a full pipe can't stall the
/// child), the child is killed past `timeout`. Err names what happened.
pub fn output_timeout(cmd: &mut Command, timeout: Duration) -> Result<Output, String> {
    let mut child = cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| e.to_string())?;
    let drain = |r: Option<Box<dyn Read + Send>>| {
        // loop: SERIAL-REQUIRED — one reader per pipe, so a full pipe can't stall the child; ends at the pipe's end
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(mut r) = r {
                // loop: SERIAL-REQUIRED — reads one pipe to its end [bounded: the pipe closes when the child exits or is killed at the deadline]
                let _ = r.read_to_end(&mut buf);
            }
            buf
        })
    };
    let out = drain(child.stdout.take().map(|s| Box::new(s) as Box<dyn Read + Send>));
    let err = drain(child.stderr.take().map(|s| Box::new(s) as Box<dyn Read + Send>));
    // loop: SERIAL-REQUIRED — the deadline wait itself
    let status = wait_timeout(&mut child, timeout).map_err(|e| e.to_string())?;
    // the readers end with the child's pipes (it exited or was killed)
    // loop: SERIAL-REQUIRED — joins the two pipe readers [bounded: the child has exited or was killed, so both pipes are closed]
    let (stdout, stderr) = (out.join().unwrap_or_default(), err.join().unwrap_or_default());
    match status {
        Some(status) => Ok(Output { status, stdout, stderr }),
        None => Err(format!("no answer within {} s; stopped", timeout.as_secs())),
    }
}

/// Linux: the child is killed when the thread that started it ends (the engine's main thread: the engine).
/// For a child with no pipe to lose: the TensorRT builder holds the graphics card for minutes, and would
/// otherwise go on building after the engine was killed (the app's cancel or quit, or the app gone).
///
/// INVARIANT: spawn such a child only from the engine's main thread (the protocol loop, `ck_engine::serve`, runs
/// jobs there). PR_SET_PDEATHSIG fires when the parent THREAD exits, not the process (prctl(2)): a child started
/// from a short-lived worker thread (a `std::thread::spawn` or a rayon task) would be killed as soon as that thread
/// ends, in the middle of its work (tests: `a_child_started_to_die_with_its_parent_does`).
pub fn die_with_parent(cmd: &mut Command) -> &mut Command {
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::process::CommandExt;
        extern "C" {
            fn prctl(option: std::os::raw::c_int, arg2: std::os::raw::c_ulong, ...) -> std::os::raw::c_int;
        }
        // SAFETY: prctl(2) is async-signal-safe; it only sets this child's parent-death signal (1 = PR_SET_PDEATHSIG,
        // 9 = SIGKILL) between fork and exec
        unsafe {
            cmd.pre_exec(|| {
                prctl(1, 9);
                Ok(())
            });
        }
    }
    cmd
}

/// The engine ends with the app that started it, on every system (the hardcoded-values pass 2026-10-24: this was
/// Linux-only, so on Windows and macOS an app crash left the engine keying, and holding the graphics card, for a
/// whole job nobody would see; measured on Linux before the fix: tests/lifetime.rs).
///  - Linux: the kernel kills it when its parent goes (PR_SET_PDEATHSIG); its children die with it the same way
///    (`die_with_parent`) or end with their pipes.
///  - Windows: it joins a job object that kills every process in it when the last handle closes (its ffmpeg and
///    TensorRT-builder children join it by inheritance), and a thread waits on the app's process handle
///    (`parent_pid`: the app passes its pid in CK_ENGINE_PARENT_PID) and exits when it ends.
///  - macOS: a thread checks every second whether the engine was handed to launchd (its parent is gone).
pub fn end_with_parent(parent_pid: Option<u32>) {
    #[cfg(target_os = "linux")]
    {
        let _ = parent_pid;
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
    #[cfg(windows)]
    win::end_with_parent(parent_pid);
    #[cfg(all(unix, not(target_os = "linux")))]
    {
        let _ = parent_pid;
        extern "C" {
            fn getppid() -> std::os::raw::c_int;
        }
        // SAFETY: getppid(2) has no arguments
        let parent = unsafe { getppid() };
        // loop: SERIAL-REQUIRED — the parent watch: one check a second for the engine's whole life [bounded: exits when the parent is gone]
        std::thread::spawn(move || loop {
            // SAFETY: as above
            if unsafe { getppid() } != parent {
                std::process::exit(1);
            }
            // loop: SERIAL-REQUIRED — the watch's one-second sleep (not a spin)
            std::thread::sleep(Duration::from_secs(1));
        });
    }
}

/// The app's pid as it passes it (CK_ENGINE_PARENT_PID); None when absent or not a pid (a bench run, a shell).
pub fn parent_pid_from(v: Option<&str>) -> Option<u32> {
    v.and_then(|s| s.trim().parse::<u32>().ok()).filter(|&p| p > 0)
}

#[cfg(windows)]
mod win {
    use std::ffi::c_void;
    type Handle = *mut c_void;
    // kernel32's own calls (no extra DLL: the engine needs only what every Windows has)
    #[link(name = "kernel32")]
    extern "system" {
        fn CreateJobObjectW(attrs: *mut c_void, name: *const u16) -> Handle;
        fn SetInformationJobObject(job: Handle, class: i32, info: *const c_void, len: u32) -> i32;
        fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
        fn GetCurrentProcess() -> Handle;
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> Handle;
        fn WaitForSingleObject(h: Handle, ms: u32) -> u32;
        fn GetLastError() -> u32;
    }
    const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS: i32 = 9;
    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x2000;
    const SYNCHRONIZE: u32 = 0x0010_0000;
    const INFINITE: u32 = 0xFFFF_FFFF;
    const ERROR_INVALID_PARAMETER: u32 = 87;

    #[repr(C)]
    #[derive(Default)]
    struct BasicLimits {
        per_process_user_time: i64,
        per_job_user_time: i64,
        limit_flags: u32,
        min_working_set: usize,
        max_working_set: usize,
        active_process_limit: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
    }
    #[repr(C)]
    #[derive(Default)]
    struct ExtendedLimits {
        basic: BasicLimits,
        io: [u64; 6],
        process_memory_limit: usize,
        job_memory_limit: usize,
        peak_process_memory: usize,
        peak_job_memory: usize,
    }
    // JOBOBJECT_EXTENDED_LIMIT_INFORMATION is 144 bytes on 64-bit Windows
    #[cfg(target_pointer_width = "64")]
    const _: () = assert!(std::mem::size_of::<ExtendedLimits>() == 144);

    pub fn end_with_parent(parent_pid: Option<u32>) {
        // SAFETY: documented kernel32 calls with a zeroed, correctly sized JOBOBJECT_EXTENDED_LIMIT_INFORMATION;
        // the job handle is kept open for the engine's whole life on purpose (closing it is what kills the job)
        unsafe {
            let job = CreateJobObjectW(std::ptr::null_mut(), std::ptr::null());
            if !job.is_null() {
                let mut info = ExtendedLimits::default();
                info.basic.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let ok = SetInformationJobObject(
                    job,
                    JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
                    &info as *const _ as *const c_void,
                    std::mem::size_of::<ExtendedLimits>() as u32,
                );
                if ok != 0 {
                    AssignProcessToJobObject(job, GetCurrentProcess());
                }
            }
            let Some(pid) = parent_pid else { return };
            let parent = OpenProcess(SYNCHRONIZE, 0, pid);
            if parent.is_null() {
                // no such process: the app is already gone
                if GetLastError() == ERROR_INVALID_PARAMETER {
                    std::process::exit(1);
                }
                return;
            }
            let parent = parent as usize;
            // loop: SERIAL-REQUIRED — waits on the app's process handle for the engine's whole life [bounded: returns when the app ends]
            std::thread::spawn(move || {
                WaitForSingleObject(parent as Handle, INFINITE);
                std::process::exit(1);
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_apps_pid_is_read_as_the_app_passes_it() {
        assert_eq!(parent_pid_from(Some("4242")), Some(4242));
        assert_eq!(parent_pid_from(Some(" 17 ")), Some(17));
        assert_eq!(parent_pid_from(Some("0")), None);
        assert_eq!(parent_pid_from(Some("app")), None);
        assert_eq!(parent_pid_from(None), None);
    }

    #[test]
    fn output_and_deadline() {
        let o = output_timeout(Command::new("sh").args(["-c", "echo hi; echo err >&2"]), Duration::from_secs(10)).unwrap();
        assert!(o.status.success());
        assert_eq!((o.stdout.as_slice(), o.stderr.as_slice()), (&b"hi\n"[..], &b"err\n"[..]));
        let t = Instant::now();
        let e = output_timeout(Command::new("sleep").arg("30"), Duration::from_millis(300)).unwrap_err();
        assert!(e.contains("no answer") && t.elapsed() < Duration::from_secs(5), "{e}");
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn a_child_started_to_die_with_its_parent_does() {
        // started from a thread that then ends: the kernel kills the child with it
        let pid = std::thread::spawn(|| die_with_parent(Command::new("sleep").arg("30")).spawn().unwrap().id()).join().unwrap();
        let end = Instant::now() + Duration::from_secs(5);
        let alive = || std::fs::read_to_string(format!("/proc/{pid}/stat")).map(|s| !s.contains(") Z ")).unwrap_or(false);
        // loop: SERIAL-REQUIRED — a 20 ms poll [bounded: 5 s]
        while alive() && Instant::now() < end {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(!alive(), "sleep outlived the thread that started it");
    }
}
