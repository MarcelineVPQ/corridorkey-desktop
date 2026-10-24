//! The engine process's protocol loop (docs/ENGINE_PROTOCOL.md): JSON lines on stdin/stdout, the same
//! replies and semantics as engine/ck_engine.py. stdout carries only protocol replies; logs go to stderr.
use ck_core::job::{parse, JobConfig};
use ck_core::pipeline::{JobResult, Sink};
use ck_core::Error;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::io::{BufRead, Write};
use std::time::Instant;

/// The engine's version: the workspace's (engine-rs/Cargo.toml), so a release bump changes it in one place.
pub const ENGINE_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const PROTOCOL: i64 = 1;

/// What runs the jobs: the ONNX Runtime pipeline, or a fake in the protocol tests.
pub trait Backend {
    fn pong(&mut self) -> Value;
    fn run(&mut self, job: &JobConfig, sink: &mut dyn Sink) -> Result<JobResult, Error>;
}

/// Writes replies as JSON lines, adding the job id when there is one.
pub struct Replies<W: Write> {
    out: W,
    pub job: Option<String>,
}

impl<W: Write> Replies<W> {
    pub fn new(out: W) -> Self {
        Replies { out, job: None }
    }
    pub fn send(&mut self, mut msg: Value) {
        if let (Some(id), Some(m)) = (&self.job, msg.as_object_mut()) {
            if !m.contains_key("id") {
                m.insert("id".into(), json!(id));
            }
        }
        let line = serde_json::to_string(&msg).unwrap_or_else(|_| "{}".into());
        // a closed stdout means the app is gone: nothing left to tell it
        let _ = writeln!(self.out, "{line}");
        let _ = self.out.flush();
    }
}

impl<W: Write> Sink for Replies<W> {
    fn send(&mut self, msg: Value) {
        Replies::send(self, msg);
    }
}

fn str_field(req: &Value, k: &str) -> Option<String> {
    match req.get(k) {
        Some(Value::String(s)) if !s.is_empty() => Some(s.clone()),
        Some(Value::Number(n)) => Some(n.to_string()),
        _ => None,
    }
}

/// The requests read so far, in order. A reader thread fills it while a job runs, so a `cancel` sent for a
/// job still waiting is seen before that job starts, wherever it sits in the stream (docs/ENGINE_PROTOCOL.md:
/// "A cancel for a job still waiting removes it"). Read only between jobs, a cancel sent after the job's own
/// `run` line came too late: measured with the fake backend, `run j1, run j2, cancel j2` ran all three.
struct Inbox {
    state: std::sync::Mutex<InboxState>,
    more: std::sync::Condvar,
}

#[derive(Default)]
struct InboxState {
    /// request lines read and not yet taken, in order
    lines: std::collections::VecDeque<Line>,
    /// the input has ended (or failed): no more lines will come
    ended: bool,
}

/// One input line: its text, or why it isn't text (not UTF-8: answered as a bad request, and reading goes on).
type Line = Result<String, String>;

impl Inbox {
    /// The next request line, waiting for one; None once the input has ended and every line was taken.
    fn take(&self) -> Option<Line> {
        let mut g = self.state.lock().unwrap();
        // loop: SERIAL-REQUIRED — waits for the next request line [bounded: the reader thread ends at the input's end and says so]
        loop {
            if let Some(l) = g.lines.pop_front() {
                return Some(l);
            }
            if g.ended {
                return None;
            }
            g = self.more.wait(g).unwrap();
        }
    }

    /// Whether a `cancel` for `id` is among the lines read but not yet taken.
    fn cancel_queued(&self, id: &str) -> bool {
        let g = self.state.lock().unwrap();
        // loop: NOT-WORTH — the few requests queued behind a job, once per job start
        g.lines.iter().flatten().any(|l| {
            serde_json::from_str::<Value>(l)
                .is_ok_and(|v| v.get("cmd").and_then(|c| c.as_str()) == Some("cancel") && str_field(&v, "id").as_deref() == Some(id))
        })
    }
}

/// Serve requests until `quit` or the end of input. One job at a time, in order.
pub fn serve<B: Backend, R: BufRead + Send + 'static, W: Write>(backend: &mut B, input: R, out: W) {
    let inbox = std::sync::Arc::new(Inbox { state: std::sync::Mutex::new(InboxState::default()), more: std::sync::Condvar::new() });
    let reader = inbox.clone();
    // loop: SERIAL-REQUIRED — the request reader: lines in order into the inbox; ends at the input's end (the app closes the pipe or exits)
    std::thread::spawn(move || {
        let mut input = input;
        let mut buf = Vec::new();
        // loop: SERIAL-REQUIRED — one line at a time, in order [bounded: ends at the input's end or a read error]
        loop {
            buf.clear();
            // bytes, not `lines()`: a line that isn't UTF-8 was an Err there and ended the input silently
            match input.read_until(b'\n', &mut buf) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            if buf.last() == Some(&b'\n') {
                buf.pop();
                if buf.last() == Some(&b'\r') {
                    buf.pop();
                }
            }
            let line = String::from_utf8(std::mem::take(&mut buf)).map_err(|e| format!("a request line that isn't UTF-8 text ({e})"));
            reader.state.lock().unwrap().lines.push_back(line);
            reader.more.notify_one();
        }
        reader.state.lock().unwrap().ended = true;
        reader.more.notify_one();
    });
    let mut r = Replies::new(out);
    let mut pending_cancel: HashSet<String> = HashSet::new();
    // loop: SERIAL-REQUIRED — one job at a time on one GPU; the app queues
    while let Some(line) = inbox.take() {
        let raw = match line {
            Ok(text) => text,
            Err(why) => {
                r.send(json!({"type": "error", "code": "bad-request", "message": format!("bad request: {why}")}));
                continue;
            }
        };
        let raw = raw.trim();
        if raw.is_empty() {
            continue;
        }
        let req: Value = match serde_json::from_str::<Value>(raw) {
            Ok(v) if v.get("cmd").map(|c| c.is_string()).unwrap_or(false) => v,
            Ok(_) => {
                r.send(json!({"type": "error", "code": "bad-request", "message": "bad json: not a request object"}));
                continue;
            }
            Err(e) => {
                r.send(json!({"type": "error", "code": "bad-request", "message": format!("bad json: {e}")}));
                continue;
            }
        };
        let id = req.get("id").cloned().unwrap_or(Value::Null);
        match req["cmd"].as_str().unwrap() {
            "ping" => {
                let p = backend.pong();
                r.send(p);
            }
            "quit" => return,
            "cancel" => match str_field(&req, "id") {
                Some(jid) => {
                    pending_cancel.insert(jid);
                }
                // no id: it can't name a job (it used to be filed under "null")
                None => r.send(json!({"type": "error", "id": id, "code": "bad-request", "message": "cancel needs the id of a job"})),
            },
            "run" => {
                let jid = str_field(&req, "id");
                if jid.is_none() || str_field(&req, "input").is_none() || str_field(&req, "output_dir").is_none() || str_field(&req, "temp_dir").is_none() {
                    r.send(json!({"type": "error", "id": id, "code": "bad-request", "message": "run needs id, input, output_dir and temp_dir"}));
                    continue;
                }
                let jid = jid.unwrap();
                if pending_cancel.remove(&jid) || inbox.cancel_queued(&jid) {
                    r.send(json!({"type": "error", "id": jid, "code": "cancelled", "message": "cancelled"}));
                    continue;
                }
                run_job(backend, &req, &jid, &mut r);
            }
            other => {
                r.send(json!({"type": "error", "id": id, "code": "bad-request", "message": format!("unknown cmd: {other}")}));
            }
        }
    }
}

fn run_job<B: Backend, W: Write>(backend: &mut B, req: &Value, jid: &str, r: &mut Replies<W>) {
    let started = Instant::now();
    r.job = Some(jid.to_string());
    let res = match parse(req) {
        Err(e) => Err(e),
        Ok(job) => match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| backend.run(&job, r))) {
            Ok(res) => res,
            Err(p) => {
                let m = p.downcast_ref::<String>().cloned().or_else(|| p.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_else(|| "panic".into());
                Err(Error::engine(format!("internal error: {m}")))
            }
        },
    };
    match res {
        Ok(done) => r.send(json!({
            "type": "result", "outputs": done.outputs, "settings_file": done.settings_file,
            "seconds": (started.elapsed().as_secs_f64() * 100.0).round() / 100.0
        })),
        Err(e) => {
            eprintln!("job {jid} failed: {e}");
            r.send(json!({"type": "error", "code": e.code, "message": e.message}));
        }
    }
    r.job = None;
}
