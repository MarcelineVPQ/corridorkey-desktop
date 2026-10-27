//! The engine process's protocol loop (docs/ENGINE_PROTOCOL.md): JSON lines on stdin/stdout, the same
//! replies and semantics as engine/ck_engine.py. stdout carries only protocol replies; logs go to stderr.
use ck_core::job::{parse, JobConfig};
use ck_core::pipeline::{JobResult, Sink};
use ck_core::Error;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::io::{BufRead, Write};
use std::time::Instant;

/// The engine's version: the app's (package.json, via ck-core), so a release bump changes it in one place.
pub const ENGINE_VERSION: &str = ck_core::APP_VERSION;
pub const PROTOCOL: i64 = 1;

/// What runs the jobs: the ONNX Runtime pipeline, or a fake in the protocol tests.
pub trait Backend {
    fn pong(&mut self) -> Value;
    fn run(&mut self, job: &JobConfig, sink: &mut dyn Sink) -> Result<JobResult, Error>;
    /// Back to a clean state after a job panicked: whatever it held half-made (sessions, loads started ahead) is
    /// dropped, so the next job starts as the first one did.
    fn reset(&mut self) {}
    /// The memory an `estimate` is weighed against, as the automatic window reads it; None: no reading (no card,
    /// Core ML, or a backend without one): the reply then has the estimates and no verdict.
    fn card_memory(&mut self) -> Option<ck_core::vram::CardMemory> {
        None
    }
    /// The engine's CK_ENGINE_VRAM_BUDGET_GB (a request's `vram_budget_gb` wins), as for a run.
    fn vram_budget_gb(&self) -> Option<f64> {
        None
    }
    /// The `trt_build` command: the TensorRT engines a clip of this size would use, built ahead of any job.
    fn trt_build(&mut self, _width: usize, _height: usize, _frames: usize, _vram_budget_gb: Option<f64>, _sink: &mut dyn Sink) -> Result<Value, Error> {
        Err(Error::bad_request("this engine has no TensorRT".into()))
    }
}

/// The `trt_build` command's request checks, then the build (its progress and logs carry the request's id).
fn trt_build_job<B: Backend, W: Write>(backend: &mut B, req: &Value, id: &str, r: &mut Replies<W>) {
    let size = |k: &str| req.get(k).and_then(|v| v.as_u64()).filter(|v| *v > 0 && *v <= 16384).map(|v| v as usize);
    let (Some(w), Some(h)) = (size("width"), size("height")) else {
        r.send(json!({"type": "error", "id": id, "code": "bad-request", "message": "trt_build needs width and height (1 to 16384)"}));
        return;
    };
    // a long clip by default: the window a clip shorter than it would pick may differ (the `frames` it has)
    let frames = req.get("frames").and_then(|v| v.as_u64()).filter(|v| *v > 0).map(|v| v as usize).unwrap_or(1000);
    let cap = req.get("vram_budget_gb").and_then(|v| v.as_f64()).filter(|g| g.is_finite() && *g > 0.0);
    r.job = Some(id.to_string());
    // a panic: the protocol loop's guard replies and resets the backend (it skipped the reset when caught here)
    let res = backend.trt_build(w, h, frames, cap, r);
    match res {
        Ok(v) => r.send(v),
        Err(e) => r.send(json!({"type": "error", "code": e.code.as_str(), "message": e.message})),
    }
    r.job = None;
}

/// The `estimate` command (backlog row 41): the peak graphics memory per window for a clip, before any job.
fn estimate_reply<B: Backend>(backend: &mut B, req: &Value) -> Value {
    let Some(input) = str_field(req, "input") else {
        return json!({"type": "error", "code": "bad-request", "message": "estimate needs input"});
    };
    let windows = match ck_core::vram::parse_windows(req.get("windows")) {
        Ok(w) => w,
        Err(e) => return json!({"type": "error", "code": e.code.as_str(), "message": e.message}),
    };
    let num_frames = req.get("num_frames").and_then(|v| v.as_i64()).unwrap_or(-1);
    let cap = match req.get("vram_budget_gb") {
        None | Some(Value::Null) => backend.vram_budget_gb(),
        Some(v) => match v.as_f64().filter(|g| g.is_finite() && *g > 0.0) {
            Some(g) => Some(g),
            None => return json!({"type": "error", "code": "bad-request", "message": format!("vram_budget_gb: a positive number, got {v}")}),
        },
    };
    // the run option's checks (backlog row 42): the estimate is the scaled size's
    let model_scale = match req.as_object().map(ck_core::job::model_scale).unwrap_or(Ok(1.0)) {
        Ok(s) => s,
        Err(e) => return json!({"type": "error", "code": e.code.as_str(), "message": e.message}),
    };
    let mem = backend.card_memory();
    match ck_core::vram::estimate(&input, num_frames, model_scale, &windows, mem, cap) {
        Ok(v) => v,
        Err(e) => json!({"type": "error", "code": e.code.as_str(), "message": e.message}),
    }
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
    let started = std::thread::Builder::new().name("stdin-reader".into()).spawn(move || {
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
    if let Err(e) = started {
        // no reader: nothing can come in, so the loop below ends at once instead of waiting forever
        eprintln!("corridorkey-engine: couldn't start the request reader: {e}");
        inbox.state.lock().unwrap().ended = true;
    }
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
        // one guard around the whole request (senior Rust review 2026-10-26 S3): a panic anywhere (`estimate` parsing a
        // malformed header, `colorspaces` in OCIO, a job, a TensorRT build) is that request's `engine` error, the backend
        // is reset (whatever the panic left half-made is dropped) and the engine keeps serving the queue
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| dispatch(backend, &req, &inbox, &mut pending_cancel, &mut r))) {
            Ok(true) => {}
            Ok(false) => return,
            Err(p) => {
                let m = ck_core::panic_message(&*p);
                // the job's or build's id when one was running, else the request's own
                let id = r.job.take().map(Value::from).or_else(|| req.get("id").cloned()).unwrap_or(Value::Null);
                eprintln!("request {id} panicked: {m}");
                // a reset that panics too is only logged
                if let Err(p2) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| backend.reset())) {
                    eprintln!("request {id}: resetting after the panic failed too: {}", ck_core::panic_message(&*p2));
                }
                r.send(json!({"type": "error", "id": id, "code": "engine", "message": format!("internal error: {m}")}));
            }
        }
    }
}

/// One request (the protocol loop's guard catches its panics); false: `quit`, stop serving.
fn dispatch<B: Backend, W: Write>(backend: &mut B, req: &Value, inbox: &Inbox, pending_cancel: &mut HashSet<String>, r: &mut Replies<W>) -> bool {
    let id = req.get("id").cloned().unwrap_or(Value::Null);
    match req["cmd"].as_str().unwrap() {
        "ping" => {
            let p = backend.pong();
            r.send(p);
        }
        "quit" => return false,
        // the colour spaces a config offers (backlog row 29, ck_core::ocio::describe): answered at once, between jobs
        "colorspaces" => {
            let cfg = str_field(req, "config");
            let mut reply = match ck_core::ocio::describe(cfg.as_deref(), ck_core::ocio::env_ocio().as_deref()) {
                Ok(v) => v,
                Err(e) => json!({"type": "error", "code": e.code.as_str(), "message": e.message}),
            };
            if !id.is_null() {
                reply["id"] = id;
            }
            r.send(reply);
        }
        // the peak graphics memory per window for a clip (backlog row 41): probe only, no model; between jobs
        "estimate" => {
            let mut reply = estimate_reply(backend, req);
            if !id.is_null() {
                reply["id"] = id;
            }
            r.send(reply);
        }
        // build the TensorRT engines for a size ahead of any job (the app's background build); between jobs
        "trt_build" => match str_field(req, "id") {
            Some(bid) => trt_build_job(backend, req, &bid, r),
            None => r.send(json!({"type": "error", "id": id, "code": "bad-request", "message": "trt_build needs an id"})),
        },
        "cancel" => match str_field(req, "id") {
            Some(jid) => {
                pending_cancel.insert(jid);
            }
            // no id: it can't name a job (it used to be filed under "null")
            None => r.send(json!({"type": "error", "id": id, "code": "bad-request", "message": "cancel needs the id of a job"})),
        },
        "run" => {
            let jid = str_field(req, "id");
            if jid.is_none() || str_field(req, "input").is_none() || str_field(req, "output_dir").is_none() || str_field(req, "temp_dir").is_none() {
                r.send(json!({"type": "error", "id": id, "code": "bad-request", "message": "run needs id, input, output_dir and temp_dir"}));
                return true;
            }
            let jid = jid.unwrap();
            if pending_cancel.remove(&jid) || inbox.cancel_queued(&jid) {
                r.send(json!({"type": "error", "id": jid, "code": "cancelled", "message": "cancelled"}));
                return true;
            }
            run_job(backend, req, &jid, r);
        }
        other => {
            r.send(json!({"type": "error", "id": id, "code": "bad-request", "message": format!("unknown cmd: {other}")}));
        }
    }
    true
}

fn run_job<B: Backend, W: Write>(backend: &mut B, req: &Value, jid: &str, r: &mut Replies<W>) {
    let started = Instant::now();
    r.job = Some(jid.to_string());
    let res = match parse(req) {
        Err(e) => Err(e),
        // a panic: the protocol loop's guard replies and resets the backend
        Ok(job) => backend.run(&job, r),
    };
    match res {
        Ok(done) => r.send(json!({
            "type": "result", "outputs": done.outputs, "settings_file": done.settings_file,
            "seconds": (started.elapsed().as_secs_f64() * 100.0).round() / 100.0
        })),
        Err(e) => {
            eprintln!("job {jid} failed: {e}");
            r.send(json!({"type": "error", "code": e.code.as_str(), "message": e.message}));
        }
    }
    r.job = None;
}
