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
}

impl Backend for Fake {
    fn pong(&mut self) -> Value {
        json!({"type": "pong", "version": "0.2.0", "protocol": 1, "engine": "onnxruntime", "provider": "cpu", "precision": "fp32"})
    }
    fn run(&mut self, job: &JobConfig, sink: &mut dyn Sink) -> Result<JobResult, Error> {
        self.ran.push(job.id.clone());
        match job.input.as_str() {
            "/missing.mp4" => Err(Error::input("input not found: /missing.mp4".into())),
            "/panic.mp4" => panic!("boom"),
            _ => {
                sink.send(json!({"type": "progress", "stage": "probe"}));
                sink.send(json!({"type": "clip", "width": 320, "height": 200, "fps": 24.0, "frames": 2}));
                sink.log("  a model print");
                sink.send(json!({"type": "frames", "done": 2, "total": 2}));
                Ok(JobResult { outputs: vec![format!("{}/a_alpha.mp4", job.output_dir.display())], settings_file: "/o/a_settings.txt".into() })
            }
        }
    }
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
    let mut out = Vec::new();
    let mut fake = Fake::default();
    serve(&mut fake, input.as_bytes(), &mut out);
    let replies = String::from_utf8(out).unwrap().lines().map(|l| serde_json::from_str(l).expect("every stdout line is JSON")).collect();
    (replies, fake)
}

fn run(id: &str, input: &str) -> Value {
    json!({"cmd": "run", "id": id, "input": input, "output_dir": "/o", "temp_dir": "/t", "options": {}})
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
fn quit_ends_the_loop() {
    let (r, fake) = talk(&[json!({"cmd": "quit"}), run("j1", "/a.mp4"), json!({"cmd": "ping"})], &[]);
    assert!(r.is_empty());
    assert!(fake.ran.is_empty());
}
