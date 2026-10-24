# Engine protocol (protocol 1)

Same pattern as Sonata's alignment helper (sonata-engine `align/server.py`,
`docs/LEVEL2-ALIGN.md` "Helper protocol"): the app spawns the engine and they
talk in **JSON lines**, one JSON object per line, UTF-8.

- **stdin:** requests (`"cmd"`).
- **stdout:** ONLY protocol replies (`"type"`). The model's own prints arrive as
  `log` replies.
- **stderr:** logs, tracebacks and library warnings. The app keeps the last
  lines for an error report and never parses them.

Any engine that speaks this protocol works with the app: the Rust engine on
ONNX Runtime (`engine-rs/`, `corridorkey-engine --models DIR`, docs/ENGINE_RUST.md;
the default when it is set up) and the PyTorch engine (`engine/ck_engine.py`,
run with a CorridorKey2.0 checkout's venv and `--package-root`), kept as the Rust engine's
benchmark reference (Marcy 2026-10-22).

**Versions.** The pong carries `"protocol"`. New fields are additive, and the
app ignores fields it doesn't know. The app refuses an engine whose protocol it
doesn't know.

## Lifetime (rule 11: share the machine)

A loaded model holds several GB of graphics memory, so the engine runs only
while the queue does:

1. The app spawns the engine when the queue starts and sends `ping`. The pong
   comes before any CUDA work beyond device detection.
2. The model loads on the first `run` and stays loaded for the rest of the queue.
3. When the queue is empty the app sends `quit`. The engine exits 0.

Jobs run one at a time, in the order they arrive. A `cancel` for a job still
waiting removes it (reply: error code `cancelled`), wherever it comes in the
stream: the Rust engine reads requests on their own thread while a job runs,
so a cancel sent after the job's `run` line still arrives in time (the PyTorch
engine reads between jobs only: there the cancel must come before the `run`). The running job cannot be
interrupted inside a window, so **cancelling the running job means the app
kills the engine** (SIGKILL of its process group: the engine and its ffmpeg writers). Each job
writes its temporary files into its own `temp_dir`, which the app deletes when
the job ends, however it ends (and at its start, any left by a crash).

On Linux the Rust engine ends with the process that started it (parent-death
signal): an engine whose app died doesn't keep the graphics card busy for a job
nobody will see. Its ffmpeg children end with their pipes; its TensorRT builder
gets the same signal.

## Requests

```
→ {"cmd":"ping"}
→ {"cmd":"run","id":"j1","input":"/clips/shot.mp4","output_dir":"/clips/out_shot",
   "temp_dir":"/home/u/.cache/corridorkey-desktop/jobs/j1","options":{...}}
→ {"cmd":"cancel","id":"j2"}
→ {"cmd":"quit"}
```

The app gives `output_dir` as a staging folder inside the clip's output folder (`out_shot/.corridorkey-partial`,
electron/main/partial.ts): it moves the results into place after `result`, and removes the folder after an `error`,
a cancel (the engine killed) or a crash. The engine writes there as into any output folder and cleans up nothing.

`options` (all optional; missing = the `infer.py` default):

| key | type | meaning |
|---|---|---|
| `hint_first_frame` | path | first-frame matte |
| `hint_video` | path | full hint video or frame folder |
| `hint_quality` | 0–1 | trust in the explicit hint (0.95) |
| `carry_hint` | bool | Hann carry (true) |
| `carry_hint_quality` | 0–1 | 0.95 |
| `hann_chunk`, `hann_stride` | int | a manual window; neither set and no `low_vram` = automatic from free graphics memory |
| `low_vram` | bool | staged low-memory mode |
| `vram_budget_gb` | number | cap on the graphics memory this job may use (the automatic window is chosen within it; the engine refuses to go past it). Absent = the free memory |
| `tensorrt` | bool | Rust engine: run on TensorRT (opt-in, false). Engines are built once per resolution range and cached; a network TensorRT can't build runs on CUDA, and the `provider` reply says so |
| `outputs` | list | any of `alpha fg checker cutout` (`alpha fg`) |
| `output_format` | `video` \| `exr` | `video` |
| `exr_dtype` | `half` \| `float` | `half` |
| `despill_strength` | 0–1 | 0.5 |
| `cutout_linear` | bool | false |
| `frame_dir_fps` | number | 24 |
| `frame_dir_linear` | bool | false |
| `num_frames` | int | −1 (whole clip) |
| `crf`, `preset`, `pix_fmt` | | ffmpeg settings for the video path (12, medium, yuv444p10le) |

## Replies

```
← {"type":"pong","version":"0.1.0","protocol":1,"engine":"pytorch","device":"cuda",
   "gpu":"NVIDIA GeForce RTX 5080","vram_total_mb":16303,"python":"3.12.13","torch":"2.9.1+cu128",
   "assets":{"weights":true,"foundation_stats":true,"rvm":true,"moge":true,"cradio":true}}
← {"type":"pong","version":"0.2.0","protocol":1,"engine":"onnxruntime","device":"cuda","gpu":"NVIDIA GeForce RTX 5080",
   "vram_total_mb":16303,"provider":"cuda","precision":"fp16","ort":"1.31.0","tensorrt_available":true,
   "models_dir":"/models","assets":{"cradio":true,"moge":true,"rvm":true,"stage1":true,"stage2":true},"python":null,"torch":null,
   "config":{"device":"auto","precision":null,"graph_opt":"all","arena_shrink":"auto","trt_cache":"...",...}}
← {"type":"progress","id":"j1","stage":"load|optimize|probe|rvm|foundations|keying","p":0.42,"detail":"window 3/9"}
← {"type":"provider","id":"j1","provider":"cuda|tensorrt|tensorrt+cuda|cpu","precision":"fp16","tensorrt_requested":false,
   "fallback_reason":"...","range":"h1024-1280_w1792-2176_t1-12","cache":"build|reused","pieces":{...},"fallbacks":{...},
   "build_s":{"stage1":88.0,...}}
← {"type":"clip","id":"j1","width":1920,"height":1080,"fps":23.976,"frames":240}
← {"type":"memory","id":"j1","hann_chunk":24,"hann_stride":12,"low_vram":false,"auto":true,
   "budget_gb":13.1,"estimate_gb":9.8}
← {"type":"frames","id":"j1","done":120,"total":240}
← {"type":"log","id":"j1","text":"    Hann stage1: chunk=24, stride=12, ..."}
← {"type":"result","id":"j1","outputs":["/clips/out_shot/shot_alpha.mp4",...],
   "settings_file":"/clips/out_shot/shot_settings.txt","seconds":312.4}
← {"type":"error","id":"j1","code":"oom|input|assets|no-gpu|cancelled|output|engine|bad-request","message":"..."}
```

- `progress.p` is the stage's own fraction when the stage reports one (stage-1
  windows), otherwise absent. The app never invents a fraction.
- `frames` counts finished frames handed to every selected output's writer
  (the slowest one). The writers encode on their own threads with a queue of
  at most 2 batches, so it trails the file on disk by at most 2 frames at the
  default batch of 1. At most 4 per second, plus the last frame.
- `memory` is the window this job really uses, sent before stage 1 starts. The
  Rust engine adds `provider`, `free_gb` (what it saw), `budget_cap_gb` (the
  job's `vram_budget_gb`), `budget_source` (`gpu`, or `host` on the CPU
  provider) and `estimate_basis` (`pytorch-bf16-table`: the estimate is the
  upstream runtime's PyTorch table, not an ONNX Runtime measurement).
- `config` (Rust engine pong, additive): the settings the engine runs with, read once at
  startup from its command line and `CK_ENGINE_*` variables (docs/ENGINE_RUST.md "Knobs").
- `provider` (Rust engine, additive) says what really runs the job: the
  provider and precision, and for TensorRT the shape range, whether its
  engines are built or reused, and every network that fell back to CUDA, with why.
- `optimize` (Rust engine, TensorRT only) is a one-time engine build for the
  clip's shape range, one `progress` per network built (`detail`: "stage 1 (4/5)");
  the builder reports no fraction, so it has no `p`. `build_s` in the second
  `provider` reply gives each build's seconds.
- A TensorRT job with an automatic window gets the longest window its range was
  built for: the `memory` reply then has `estimate_basis: "tensorrt-range"` and
  `range` instead of the PyTorch table's estimate.
- A request the engine can't read is answered with
  `{"type":"error","code":"bad-request","message":"..."}` and the engine keeps
  running. After a job's `error` the engine also keeps running and takes the
  next job.
- `output` (Rust engine, additive): the results or the job's temporary files can't be
  written: the folder isn't writable, the drive is read-only or its disk is full (the
  message says which). Before, these were `engine`.
- Rust engine: a request line that isn't UTF-8 text, a `cancel` without an `id`, a
  `run` option outside its documented range (`hint_quality`, `carry_hint_quality`,
  `despill_strength`: 0–1; for video output a `preset` or `pix_fmt` libx264 doesn't take, a
  `crf` outside 0–51, or 0–63 for 10-bit formats) or a number that isn't finite (`"nan"`, `"inf"`) is a
  `bad-request` (for a `run`, with its id, before anything loads); the engine keeps
  reading. An option that isn't a number at all stays an `input` error.
