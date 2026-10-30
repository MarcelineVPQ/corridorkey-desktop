//! docs/ENGINE_PROTOCOL.md with a fake pipeline: the replies, their ids, the error codes and the engine
//! staying up after a failed job.
use ck_core::job::JobConfig;
use ck_core::pipeline::{JobResult, Sink};
use ck_core::Error;
use ck_engine::{serve, Backend};
use serde_json::{json, Value};

#[derive(Default)]
struct Fake {
    ran: Vec<String>,
    /// state a job leaves behind (sessions, loads); a panicking job leaves it half-made
    half_made: bool,
    /// what each job found when it started
    found_half_made: Vec<bool>,
    resets: usize,
    /// a request whose backend call panics: "pong" (`ping`), "card_memory" (`estimate`), "trt_build"
    panic_in: Option<&'static str>,
}

impl Backend for Fake {
    fn pong(&mut self) -> Value {
        if self.panic_in == Some("pong") {
            self.half_made = true;
            panic!("pong boom")
        }
        json!({"type": "pong", "version": "0.2.0", "protocol": 1, "engine": "onnxruntime", "provider": "cpu", "precision": "fp32"})
    }
    fn run(&mut self, job: &JobConfig, sink: &mut dyn Sink) -> Result<JobResult, Error> {
        self.ran.push(job.id.clone());
        self.found_half_made.push(self.half_made);
        match job.input.as_str() {
            "/missing.mp4" => Err(Error::input("input not found: /missing.mp4".into())),
            "/panic.mp4" => {
                self.half_made = true;
                panic!("boom")
            }
            // a job long enough that the reader thread has queued every later line before it ends (the tests that cancel
            // a waiting job: an instant job let the next run start before the cancel was read, Windows CI 2026-10-28)
            "/slow.mp4" => {
                // loop: SERIAL-REQUIRED — holds the job while the reader queues the rest [bounded: 300 ms]
                std::thread::sleep(std::time::Duration::from_millis(300));
                Ok(JobResult { outputs: vec![], settings_file: "/o/a_settings.txt".into() })
            }
            _ => {
                sink.send(json!({"type": "progress", "stage": "probe"}));
                sink.send(json!({"type": "clip", "width": 320, "height": 200, "fps": 24.0, "frames": 2}));
                sink.log("  a model print");
                sink.send(json!({"type": "frames", "done": 2, "total": 2}));
                Ok(JobResult { outputs: vec![format!("{}/a_alpha.mp4", job.output_dir.display())], settings_file: "/o/a_settings.txt".into() })
            }
        }
    }
    fn reset(&mut self) {
        self.resets += 1;
        self.half_made = false;
    }
    fn card_memory(&mut self) -> Option<ck_core::vram::CardMemory> {
        if self.panic_in == Some("card_memory") {
            self.half_made = true;
            panic!("estimate boom")
        }
        None
    }
    fn trt_build(&mut self, _w: usize, _h: usize, _frames: usize, _window: Option<usize>, _cap: Option<f64>, _sink: &mut dyn Sink) -> Result<Value, Error> {
        if self.panic_in == Some("trt_build") {
            self.half_made = true;
            panic!("build boom")
        }
        Ok(json!({"type": "trt_built"}))
    }
}

/// senior Rust review 2026-10-26 S3: a panic in any request (not only `run`) is that request's `engine` error with its
/// id, the backend is reset, and the engine keeps serving the requests queued behind it (they were lost: the process
/// ended). `trt_build`'s panic was caught but skipped the reset.
#[test]
fn a_panic_in_any_request_is_an_error_reply_and_the_engine_keeps_serving() {
    // loop: NOT-WORTH — three requests that panic
    for (panic_in, req) in [
        ("pong", json!({"cmd": "ping", "id": "p1"})),
        ("card_memory", json!({"cmd": "estimate", "id": "e1", "input": "/clip.mov", "windows": [[8, 4, false]]})),
        ("trt_build", json!({"cmd": "trt_build", "id": "b1", "width": 1920, "height": 1080})),
    ] {
        let fake = Fake { panic_in: Some(panic_in), ..Fake::default() };
        let (r, fake) = talk_to(fake, &[req.clone(), run("j1", "/a.mp4"), json!({"cmd": "quit"})]);
        let id = req["id"].as_str();
        assert_eq!((r[0]["type"].as_str(), r[0]["id"].as_str(), r[0]["code"].as_str()), (Some("error"), id, Some("engine")), "{panic_in}: {}", r[0]);
        assert!(r[0]["message"].as_str().unwrap().starts_with("internal error: ") && r[0]["message"].as_str().unwrap().contains("boom"), "{}", r[0]);
        // reset once, before the queued job, which found nothing half-made and ran
        assert_eq!((fake.resets, fake.found_half_made.clone(), fake.ran.clone()), (1, vec![false], vec!["j1".to_string()]), "{panic_in}");
        assert_eq!(r.last().unwrap()["type"], "result", "{panic_in}");
    }
}

#[test]
fn after_a_panic_the_backend_is_reset_before_the_next_job() {
    let (r, fake) = talk(&[run("j1", "/a.mp4"), run("j2", "/panic.mp4"), run("j3", "/missing.mp4"), run("j4", "/a.mp4")], &[]);
    assert_eq!(fake.ran, vec!["j1", "j2", "j3", "j4"]);
    // reset once, after the panic only (not after a normal failure); no job found the panic's leftovers
    assert_eq!(fake.resets, 1);
    assert_eq!(fake.found_half_made, vec![false, false, false, false]);
    assert_eq!(r.last().unwrap()["type"], "result");
}

fn talk(lines: &[Value], raw: &[&str]) -> (Vec<Value>, Fake) {
    let mut input = String::new();
    // loop: NOT-WORTH — a test's few requests
    for l in lines {
        input.push_str(&serde_json::to_string(l).unwrap());
        input.push('\n');
    }
    // loop: NOT-WORTH — a test's few raw lines
    for r in raw {
        input.push_str(r);
        input.push('\n');
    }
    talk_bytes(input.into_bytes())
}

/// The engine's replies to raw input bytes.
fn talk_bytes(input: Vec<u8>) -> (Vec<Value>, Fake) {
    talk_bytes_to(Fake::default(), input)
}

/// `talk` with a fake set up by the test.
fn talk_to(fake: Fake, lines: &[Value]) -> (Vec<Value>, Fake) {
    // loop: NOT-WORTH — a test's few requests
    let input = lines.iter().flat_map(line).collect();
    talk_bytes_to(fake, input)
}

fn talk_bytes_to(mut fake: Fake, input: Vec<u8>) -> (Vec<Value>, Fake) {
    let mut out = Vec::new();
    serve(&mut fake, std::io::Cursor::new(input), &mut out);
    // loop: NOT-WORTH — a test's few replies
    let replies = String::from_utf8(out).unwrap().lines().map(|l| serde_json::from_str(l).expect("every stdout line is JSON")).collect();
    (replies, fake)
}

fn line(v: &Value) -> Vec<u8> {
    let mut b = serde_json::to_vec(v).unwrap();
    b.push(b'\n');
    b
}

#[test]
fn a_line_that_is_not_utf8_is_a_bad_request_and_reading_goes_on() {
    let mut input = b"{\"cmd\":\"ping\xff\xfe\"}\n".to_vec();
    input.extend(line(&run("j1", "/a.mp4")));
    input.extend(b"\xc3\x28\r\n");
    input.extend(line(&json!({"cmd": "ping"})));
    let (r, fake) = talk_bytes(input);
    assert_eq!((r[0]["type"].as_str(), r[0]["code"].as_str()), (Some("error"), Some("bad-request")));
    assert!(r[0]["message"].as_str().unwrap().contains("UTF-8"), "{}", r[0]);
    assert_eq!(fake.ran, vec!["j1"]);
    // loop: NOT-WORTH — a test's few replies
    let codes: Vec<&str> = r.iter().filter_map(|m| m["code"].as_str()).collect();
    assert_eq!(codes, vec!["bad-request", "bad-request"]);
    assert_eq!(r.last().unwrap()["type"], "pong");
}

#[test]
fn a_cancel_without_an_id_is_a_bad_request() {
    let (r, fake) = talk(&[json!({"cmd": "cancel"}), json!({"cmd": "cancel", "id": null}), run("null", "/a.mp4")], &[]);
    assert_eq!((r[0]["code"].as_str(), r[1]["code"].as_str()), (Some("bad-request"), Some("bad-request")));
    assert!(r[0]["message"].as_str().unwrap().contains("cancel needs"));
    // a job whose id is the text "null" is not cancelled by them
    assert_eq!(fake.ran, vec!["null"]);
    assert_eq!(r.last().unwrap()["type"], "result");
}

#[test]
fn out_of_range_and_non_finite_options_are_bad_requests_without_running() {
    // loop: NOT-WORTH — a test's few options
    for o in [
        json!({"hint_quality": 1.5}),
        json!({"carry_hint_quality": -0.1}),
        json!({"despill_strength": 2}),
        json!({"despill_strength": "nan"}),
        json!({"frame_dir_fps": "inf"}),
        json!({"vram_budget_gb": "-inf"}),
    ] {
        let mut req = run("j1", "/a.mp4");
        req["options"] = o.clone();
        let (r, fake) = talk(&[req], &[]);
        assert_eq!((r[0]["code"].as_str(), r[0]["id"].as_str()), (Some("bad-request"), Some("j1")), "{o}");
        assert!(fake.ran.is_empty(), "{o}");
    }
}

#[test]
fn trt_build_refuses_invalid_fields_instead_of_ignoring_them() {
    // final review 2026-10-28 N6: vram_budget_gb 0 / -1 / "x" and frames 0 were ignored, so the build sized its window
    // for the whole card while the job used its budget, and the job's range said "not built"
    // loop: NOT-WORTH — a test's few requests
    for extra in [
        json!({"vram_budget_gb": 0}),
        json!({"vram_budget_gb": -1}),
        json!({"vram_budget_gb": "x"}),
        json!({"frames": 0}),
        json!({"frames": -5}),
        json!({"frames": 2.5}),
        json!({"window": 0}),
        json!({"window": "x"}),
    ] {
        let mut req = json!({"cmd": "trt_build", "id": "b1", "width": 1920, "height": 1080});
        // loop: NOT-WORTH — one field
        for (k, v) in extra.as_object().unwrap() {
            req[k] = v.clone();
        }
        let (r, _) = talk(&[req], &[]);
        assert_eq!((r[0]["type"].as_str(), r[0]["code"].as_str(), r[0]["id"].as_str()), (Some("error"), Some("bad-request"), Some("b1")), "{extra}: {}", r[0]);
    }
    // absent or null: the defaults; valid values build
    let (r, _) =
        talk(&[json!({"cmd": "trt_build", "id": "b1", "width": 1920, "height": 1080, "frames": 48, "window": 4, "vram_budget_gb": 8, "x": null})], &[]);
    assert_eq!(r[0]["type"], "trt_built", "{}", r[0]);
    // trt_windows (the checklist): a malformed size list is refused before the backend sees it
    // loop: NOT-WORTH — a test's few requests
    for sizes in [json!(null), json!([{"width": 0, "height": 1080}]), json!([{"width": 1920}]), json!("4K")] {
        let (r, _) = talk(&[json!({"cmd": "trt_windows", "id": "w1", "sizes": sizes})], &[]);
        assert_eq!((r[0]["code"].as_str(), r[0]["id"].as_str()), (Some("bad-request"), Some("w1")), "{sizes}: {}", r[0]);
        assert!(r[0]["message"].as_str().unwrap().starts_with("trt_windows"), "{}", r[0]);
    }
}

fn run(id: &str, input: &str) -> Value {
    json!({"cmd": "run", "id": id, "input": input, "output_dir": "/o", "temp_dir": "/t", "options": {}})
}

#[test]
fn colorspaces_lists_a_configs_spaces_and_a_bad_config_is_a_bad_request() {
    let (r, fake) = talk(
        &[
            json!({"cmd": "colorspaces", "id": "c1", "config": "ocio://studio-config-latest"}),
            json!({"cmd": "colorspaces", "config": "/no/such/config.ocio"}),
            run("j1", "/a.mp4"),
        ],
        &[],
    );
    assert_eq!((r[0]["type"].as_str(), r[0]["id"].as_str()), (Some("colorspaces"), Some("c1")));
    let name = r[0]["config"]["name"].as_str().unwrap();
    assert!(name.starts_with("ocio://studio-config-v"), "{name}");
    assert!(r[0]["config"]["ocio"].as_str().unwrap().starts_with("2.5."));
    assert!(!r[0]["config"]["cache_id"].as_str().unwrap().is_empty());
    assert_eq!(r[0]["roles"]["scene_linear"], "ACEScg");
    // loop: NOT-WORTH — a config's few dozen spaces
    let cg = r[0]["colorspaces"].as_array().unwrap().iter().find(|s| s["name"] == "ACEScg").unwrap().clone();
    assert_eq!((cg["family"].as_str().is_some(), cg["isdata"].as_bool(), cg["aliases"].is_array()), (true, Some(false), true));
    assert_eq!((r[1]["type"].as_str(), r[1]["code"].as_str()), (Some("error"), Some("bad-request")));
    assert!(r[1]["message"].as_str().unwrap().contains("/no/such/config.ocio"));
    // the engine keeps going
    assert_eq!(fake.ran, vec!["j1"]);
}

/// A 1x1 PNG (the image crate reads only its header for the size).
const PNG_1X1: [u8; 70] = [
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120,
    218, 99, 100, 96, 248, 95, 15, 0, 2, 135, 1, 128, 235, 71, 186, 146, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
];

#[test]
fn estimate_answers_per_window_with_its_id_and_bad_ones_are_bad_requests() {
    let dir = std::env::temp_dir().join(format!("ck-proto-estimate-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    // loop: NOT-WORTH — two test frames
    for i in 1..=2 {
        std::fs::write(dir.join(format!("f_{i:04}.png")), PNG_1X1).unwrap();
    }
    let clip = dir.to_str().unwrap();
    let (r, fake) = talk(
        &[
            json!({"cmd": "estimate", "id": "e1", "input": clip, "windows": [[24, 12, false], [8, 4, true]]}),
            json!({"cmd": "estimate", "id": "e2", "input": "/no/such/clip.mov", "windows": [[8, 4, false]]}),
            json!({"cmd": "estimate", "id": "e3", "input": clip, "windows": [[4, 8, false]]}),
            json!({"cmd": "estimate", "id": "e4", "windows": [[8, 4, false]]}),
            json!({"cmd": "estimate", "id": "e5", "input": clip, "windows": [[8, 4, false]], "vram_budget_gb": "lots"}),
            json!({"cmd": "estimate", "id": "e6", "input": clip, "windows": [[8, 4, false]], "model_scale": 0}),
            json!({"cmd": "estimate", "id": "e7", "input": clip, "windows": [[8, 4, false]], "model_scale": 2}),
            json!({"cmd": "ping"}),
        ],
        &[],
    );
    let _ = std::fs::remove_dir_all(&dir);
    assert!(fake.ran.is_empty(), "an estimate runs no job");
    assert_eq!((r[0]["type"].as_str(), r[0]["id"].as_str()), (Some("estimate"), Some("e1")));
    assert_eq!((r[0]["shape_w"].as_u64(), r[0]["shape_h"].as_u64(), r[0]["frames"].as_u64()), (Some(128), Some(128), Some(2)));
    let w = r[0]["windows"].as_array().unwrap();
    assert_eq!(w.len(), 2);
    // the window is capped at the clip's 2 frames; the fake has no memory reading: estimates without a verdict
    assert_eq!((w[0]["hann_chunk"].as_u64(), w[0]["frames"].as_u64(), w[0]["fits"].clone()), (Some(24), Some(2), Value::Null));
    assert!(w[0]["peak_bytes"].as_u64().unwrap() > w[1]["peak_bytes"].as_u64().unwrap(), "normal mode needs more than low-memory");
    assert_eq!(r[0]["free_bytes"], Value::Null);
    assert_eq!((r[1]["type"].as_str(), r[1]["id"].as_str(), r[1]["code"].as_str()), (Some("error"), Some("e2"), Some("input")));
    // loop: NOT-WORTH — four replies
    for (i, id) in [(2, "e3"), (3, "e4"), (4, "e5"), (5, "e6")] {
        assert_eq!((r[i]["id"].as_str(), r[i]["code"].as_str()), (Some(id), Some("bad-request")), "{}", r[i]);
    }
    // model scale: the scaled size (1x1 at 2.0 -> 2x2)
    assert_eq!((r[6]["id"].as_str(), r[6]["model_w"].as_u64(), r[6]["model_h"].as_u64(), r[6]["width"].as_u64()), (Some("e7"), Some(2), Some(2), Some(1)));
    assert_eq!(r[7]["type"], "pong", "the engine keeps running");
}

#[test]
fn ping_pong() {
    let (r, _) = talk(&[json!({"cmd": "ping"})], &[]);
    assert_eq!(r[0]["type"], "pong");
    assert_eq!(r[0]["protocol"], 1);
    assert_eq!(r[0]["engine"], "onnxruntime");
}

#[test]
fn a_job_reports_with_its_id_then_the_result() {
    let (r, _) = talk(&[run("j1", "/a.mp4")], &[]);
    let types: Vec<&str> = r.iter().map(|m| m["type"].as_str().unwrap()).collect();
    assert_eq!(types, vec!["progress", "clip", "log", "frames", "result"]);
    assert!(r.iter().all(|m| m["id"] == "j1"), "{r:?}");
    assert_eq!(r[2]["text"], "  a model print");
    assert_eq!(r[4]["outputs"], json!(["/o/a_alpha.mp4"]));
    assert_eq!(r[4]["settings_file"], "/o/a_settings.txt");
    assert!(r[4]["seconds"].as_f64().unwrap() >= 0.0);
}

#[test]
fn bad_requests_keep_the_engine_running() {
    let (r, _) = talk(&[json!({"cmd": "dance", "id": "x"}), json!({"cmd": "run", "id": "j1"}), json!([1, 2]), json!({"cmd": "ping"})], &["{not json"]);
    assert_eq!((r[0]["code"].as_str(), r[0]["id"].as_str()), (Some("bad-request"), Some("x")));
    assert!(r[0]["message"].as_str().unwrap().contains("unknown cmd: dance"));
    assert_eq!(r[1]["code"], "bad-request");
    assert_eq!(r[1]["message"], "run needs id, input, output_dir and temp_dir");
    assert_eq!(r[2]["code"], "bad-request");
    assert_eq!(r[3]["type"], "pong");
    assert_eq!(r[4]["code"], "bad-request"); // the raw line comes last
    assert!(r[4]["message"].as_str().unwrap().starts_with("bad json"));
}

#[test]
fn errors_have_codes_and_the_next_job_runs() {
    let (r, fake) = talk(&[run("j1", "/missing.mp4"), run("j2", "/panic.mp4"), run("j3", "/a.mp4")], &[]);
    assert_eq!((r[0]["type"].as_str(), r[0]["code"].as_str(), r[0]["id"].as_str()), (Some("error"), Some("input"), Some("j1")));
    assert_eq!((r[1]["code"].as_str(), r[1]["id"].as_str()), (Some("engine"), Some("j2")));
    assert!(r[1]["message"].as_str().unwrap().contains("boom"));
    assert_eq!(r.last().unwrap()["type"], "result");
    assert_eq!(fake.ran, vec!["j1", "j2", "j3"]);
}

#[test]
fn bad_options_are_input_errors_without_running() {
    let mut req = run("j1", "/a.mp4");
    req["options"] = json!({"outputs": ["alpha", "nope"]});
    let (r, fake) = talk(&[req], &[]);
    assert_eq!((r[0]["code"].as_str(), r[0]["id"].as_str()), (Some("input"), Some("j1")));
    assert!(fake.ran.is_empty());
}

#[test]
fn cancel_removes_a_waiting_job() {
    let (r, fake) = talk(&[json!({"cmd": "cancel", "id": "j2"}), run("j2", "/a.mp4"), run("j3", "/a.mp4")], &[]);
    assert_eq!((r[0]["type"].as_str(), r[0]["code"].as_str(), r[0]["id"].as_str()), (Some("error"), Some("cancelled"), Some("j2")));
    assert_eq!(fake.ran, vec!["j3"]);
}

#[test]
fn cancel_sent_after_the_run_line_removes_the_waiting_job() {
    // the app (or any client) queued j2 behind j1, then cancelled it while j1 ran
    let (r, fake) = talk(&[run("j1", "/slow.mp4"), run("j2", "/a.mp4"), json!({"cmd": "cancel", "id": "j2"}), run("j3", "/a.mp4")], &[]);
    assert_eq!(fake.ran, vec!["j1", "j3"]);
    // loop: NOT-WORTH — a test's few replies
    let j2: Vec<&Value> = r.iter().filter(|m| m["id"] == "j2").collect();
    assert_eq!(j2.len(), 1);
    assert_eq!((j2[0]["type"].as_str(), j2[0]["code"].as_str()), (Some("error"), Some("cancelled")));
}

#[test]
fn a_cancel_that_removed_a_waiting_job_doesnt_cancel_a_later_run_with_its_id() {
    // final review 2026-10-28 N7: the cancel line stayed queued, landed in pending_cancel and cancelled the retry
    let (r, fake) = talk(&[run("j1", "/slow.mp4"), run("j2", "/a.mp4"), json!({"cmd": "cancel", "id": "j2"}), run("j2", "/a.mp4")], &[]);
    assert_eq!(fake.ran, vec!["j1", "j2"]);
    // loop: NOT-WORTH — a test's few replies
    let j2: Vec<&str> = r.iter().filter(|m| m["id"] == "j2" && (m["type"] == "error" || m["type"] == "result")).map(|m| m["type"].as_str().unwrap()).collect();
    assert_eq!(j2, ["error", "result"]);
}

#[test]
fn a_cancel_after_a_queued_retry_cancels_the_retry_not_the_run_before_it() {
    // engine re-review 2026-10-28 #4: with `run j2, run j2, cancel j2` queued, the cancel took the first run
    let (r, fake) = talk(&[run("j1", "/slow.mp4"), run("j2", "/a.mp4"), run("j2", "/a.mp4"), json!({"cmd": "cancel", "id": "j2"})], &[]);
    assert_eq!(fake.ran, vec!["j1", "j2"]);
    // loop: NOT-WORTH — a test's few replies
    let j2: Vec<&str> = r.iter().filter(|m| m["id"] == "j2" && (m["type"] == "error" || m["type"] == "result")).map(|m| m["type"].as_str().unwrap()).collect();
    assert_eq!(j2, ["result", "error"]);
}

#[test]
fn quit_ends_the_loop() {
    let (r, fake) = talk(&[json!({"cmd": "quit"}), run("j1", "/a.mp4"), json!({"cmd": "ping"})], &[]);
    assert!(r.is_empty());
    assert!(fake.ran.is_empty());
}

#[test]
fn the_version_is_the_apps() {
    // the pong's `version` and `--version`: the app release (package.json), not the Rust workspace's (backlog row 94)
    let pkg: Value = serde_json::from_str(&std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../package.json")).unwrap()).unwrap();
    assert_eq!(ck_engine::ENGINE_VERSION, pkg["version"].as_str().unwrap());
}
