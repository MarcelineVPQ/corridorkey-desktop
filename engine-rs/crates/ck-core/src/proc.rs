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
}
