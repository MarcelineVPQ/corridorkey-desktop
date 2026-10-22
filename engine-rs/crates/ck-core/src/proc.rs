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

#[cfg(test)]
mod tests {
    use super::*;

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
