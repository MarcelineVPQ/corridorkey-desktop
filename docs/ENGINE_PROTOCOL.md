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
→ {"cmd":"colorspaces","id":"c1","config":"ocio://studio-config-latest"}
→ {"cmd":"estimate","id":"e1","input":"/clips/04_5h","windows":[[8,4,true],[16,8,true]]}
→ {"cmd":"trt_build","id":"b1","width":4096,"height":2160}
→ {"cmd":"quit"}
```

`trt_build` (Rust engine, additive, 2026-10-25): build the TensorRT engines a clip of `width` × `height` would use,
ahead of any job (the app's background build, so a job never waits on one). `frames` (default 1000, a long clip) and
`vram_budget_gb` (as the run option) as a run takes them. The engine pads the size as a run does, picks the window a
TensorRT job of that size picks (the automatic window in low-VRAM mode, against the free memory it reads now), and
builds every network of that range not built yet with the same builder a job uses (`progress` replies, stage
`optimize`, with `piece`; `log` lines). Then `{"type":"trt_built","id":"b1","width":4096,"height":2160,
"range":"h1792-2176_w3584-4096_t1-8_f1-4","hann_chunk":8,"hann_stride":4,"reused":false,"built_s":{"stage1":139.2,…},
"fallbacks":{}}` (`reused`: everything was built before; `fallbacks`: networks that couldn't be built, which run on
CUDA). Without the graphics card and ONNX Runtime's TensorRT provider, or for a size outside the TensorRT ranges, a
`bad-request` that says why. Answered between jobs; the app ends it by killing the engine (the builder dies with it,
and a half-built network is built again next time). The PyTorch engine answers `unknown cmd`.

`colorspaces` (Rust engine, additive): the colour spaces an OpenColorIO config offers, for the app's menus. `config`
as `color_config` (absent = `$OCIO`, else the built-in ACES studio config); `id` optional, echoed. Answered at once
between jobs. Reply below; an unreadable config is a `bad-request` carrying OCIO's message.

`estimate` (Rust engine, additive; backlog row 41): the peak graphics memory a run would take, per window, before
any job. `input` as a run's; `windows` a list of `[hann_chunk, hann_stride, low_vram]` (1 to 64 of them, checked as a
run's window: chunk and stride at least 1, the stride not past the chunk); optional `num_frames` and `model_scale` (as the run options: the estimate is the scaled, padded size's; the reply adds `model_scale`, `model_w`, `model_h`)
and `vram_budget_gb` (as the run option; absent = the engine's `CK_ENGINE_VRAM_BUDGET_GB`). The engine probes the clip
for its size and frame count only (ffprobe, or a frame folder's first header: nothing decoded, no model loaded, no
CUDA context) and answers at once between jobs. Each window's `peak_bytes` is the estimate the automatic window and
the `memory` reply use (this engine's measured ONNX Runtime CUDA peaks over the padded size, an upper bound at every
measured point, docs/BACKLOG.md row 41; the window capped at the clip's frames: `estimate_peak_vram_gb`, no second
formula); `needs_bytes` is what the automatic window requires of the
budget for it (the estimate × `margin_scale` + `margin_gb`), and `fits` is that check against `budget_bytes` (free
memory plus what the engine holds, capped by `vram_budget_gb`; NVML on a card, the host's available memory on the
CPU provider; null and no verdict where there is no reading, as on Core ML). A missing or unreadable clip is an
`input` error with the id; bad windows are a `bad-request`. The PyTorch engine answers `unknown cmd`.

The app gives `output_dir` as a staging folder inside the clip's output folder (`out_shot/.corridorkey-partial`,
electron/main/partial.ts): it moves the results into place after `result`, and removes the folder after an `error`,
a cancel (the engine killed) or a crash. The engine writes there as into any output folder and cleans up nothing.

`options` (all optional; missing = the `infer.py` default):

| key | type | meaning |
|---|---|---|
| `hint_first_frame` | path | first-frame matte (read as cv2.imread(IMREAD_UNCHANGED) reads it: a PNG's alpha when it has one, grey + alpha too; an EXR's `A`, else its blue as cv2's first channel, or `Y` alone) |
| `hint_video` | path | full hint video or frame folder |
| `hint_quality` | 0–1 | trust in the explicit hint (0.95) |
| `carry_hint` | bool | Hann carry (true) |
| `carry_hint_quality` | 0–1 | 0.95 |
| `hann_chunk`, `hann_stride` | int | a manual window; neither set and no `low_vram` = automatic from free graphics memory |
| `low_vram` | bool | staged low-memory mode |
| `vram_budget_gb` | number | cap on the graphics memory this job may use (the automatic window is chosen within it; the engine refuses to go past it). Absent = the free memory |
| `tensorrt` | bool | Rust engine: run on TensorRT (opt-in, false). Engines are built once per resolution range and cached; a network TensorRT can't build runs on CUDA, and the `provider` reply says so |
| `tensorrt_build` | bool | Rust engine (additive, 2026-10-25): with `tensorrt`, whether the job may build its range's engines (true, absent). false: a range not built yet runs exactly as a job without TensorRT (CUDA's own automatic window too), with `fallback_reason` "TensorRT for this resolution range isn't built yet" and a `log` line; the app sends false and builds ranges with `trt_build` |
| `outputs` | list | any of `alpha fg checker cutout` (`alpha fg`) |
| `output_format` | `video` \| `exr` | `video` |
| `exr_dtype` | `half` \| `float` | `half` |
| `despill_strength` | 0–1 | 0.5 |
| `cutout_linear` | bool | false |
| `frame_dir_fps` | number | 24 |
| `frame_dir_linear` | bool | false |
| `num_frames` | int | −1 (whole clip) |
| `model_scale` | number | Rust engine (backlog row 42; docs/PARITY.md): the internal resolution, the original's `--model_scale`. 1.0 (absent) = native; above 0, at most 2.0, else a `bad-request`. Frames (and hints) are resized with cv2's Lanczos-4 (ported bit for bit) to each side × the scale (Python's round, half to even), padded, keyed, and the outputs resized back to the native size at the points where the original calls its output resize (which upstream leaves unimplemented: its own runtime stops at any scale but 1.0; the PyTorch engine refuses one as an `input` error). A `log` line names the size the networks run at; `_settings.txt` writes the value |
| `input_bit_depth` | `"8"` \| `"16"` | Rust engine (additive, 2026-10-25; backlog row 27): how deep inputs are read. `"8"` (absent) = CorridorKey 2.0's own reader byte for byte: video decoded to 8-bit RGB as cv2.VideoCapture does whatever the source's depth, 16-bit PNG reduced to its high byte as cv2.imread(IMREAD_COLOR) does (test `default_reading_is_corridorkey_byte_identical`). `"16"` = video above 8 bits (10/12-bit ProRes, DNxHR, HEVC) decoded to 16-bit RGB and 16-bit PNG read at full depth: more precision, and different from CorridorKey 2.0. EXR is read as float either way; 8-bit sources and hints are the same either way. Any other value is a `bad-request`. A `log` line says how a video above 8 bits was read; `_settings.txt` adds `Input Bit Depth:`. The PyTorch engine always reads at 8 bits (it runs the original's reader) |
| `linear_brightness`, `linear_contrast`, `linear_contrast_pivot` | number | Rust engine and the PyTorch engine (backlog row 45): the original's scene-linear adjust, `gain * (pivot + contrast * (linear − pivot))` on the model's input and its inverse on the foreground. 1.0 / 1.0 / 0.18 (identity). **Video inputs only**, as in the original (a frame folder runs without it; a `log` line says so; `_settings.txt` adds `Linear Adjust Applied:`). Brightness and contrast at 0 or below are a `bad-request` |
| `start_mode`, `seed` | `begin` \| `middle` \| `random_middle`, int ≥ 0 | Rust engine and the PyTorch engine (backlog row 45): which part of a **video** `num_frames` takes (the original's `--start_mode` / `--seed`; `random_middle` draws with NumPy's generator, ported bit for bit). Without `num_frames`, or on a frame folder, the start is frame 0. A hint video starts at the same frame. `_settings.txt` adds `Start Frame:` |
| `video_codec` | `h264-lossless` \| `dnxhr444` \| `h264-crf12` | Rust engine, video outputs (backlog row 26): `h264-lossless` = libx264 `-qp 0`, High 4:4:4 Predictive, yuv444p10le, `.mp4`; `dnxhr444` = ffmpeg's `dnxhd` encoder, profile `dnxhr_444`, yuv444p10le, `.mov`; `h264-crf12` = the original's libx264 CRF 12, `.mp4`. Absent = `h264-crf12` (the original's output; the app sends `h264-lossless` for new jobs). Any other name is a `bad-request`; EXR jobs ignore it. None carries alpha: see the cutout below |
| `crf`, `preset`, `pix_fmt` | | ffmpeg settings for the video path (12, medium, yuv444p10le). `crf` and `pix_fmt` apply to `h264-crf12` only, `preset` to both H.264 codecs |
| `color_config` | path \| `ocio://` name | Rust engine: the OpenColorIO config for `input_colorspace` / `output_colorspace`. Absent = `$OCIO` as the engine sees it, else OCIO's built-in ACES studio config (`ocio://studio-config-latest`, recorded by its versioned name) |
| `input_colorspace` | string | Rust engine: the clip's colour space, a name (or alias, or role) in that config. Absent = today's behaviour exactly (display-coded sRGB, or scene-linear Rec.709 EXR with `frame_dir_linear`). EXR and 16/8-bit image sequences only: on a video input it is a `bad-request` (colour-managed video comes in the next version) |
| `output_colorspace` | string | Rust engine: the EXR outputs' colour space. Absent = the input's own space when `input_colorspace` is given (ACEScg in, ACEScg out), else linear Rec.709 as today. Video outputs stay display sRGB / Rec.709 whatever it says (a `log` line says so) |

## Replies

```
← {"type":"pong","version":"0.1.0","protocol":1,"engine":"pytorch","device":"cuda",
   "gpu":"NVIDIA GeForce RTX 5080","vram_total_mb":16303,"python":"3.12.13","torch":"2.9.1+cu128",
   "assets":{"weights":true,"foundation_stats":true,"rvm":true,"moge":true,"cradio":true}}
← {"type":"pong","version":"0.2.0","protocol":1,"engine":"onnxruntime","device":"cuda","gpu":"NVIDIA GeForce RTX 5080",
   "vram_total_mb":16303,"provider":"cuda","precision":"fp16","ort":"1.31.0","tensorrt_available":true,
   "models_dir":"/models","assets":{"cradio":true,"moge":true,"rvm":true,"stage1":true,"stage2":true},"python":null,"torch":null,
   "config":{"device":"auto","precision":null,"graph_opt":"all","arena_shrink":"auto","trt_cache":"...",...},
   "decoders":{"jpeg":"libjpeg-turbo (/usr/lib/libturbojpeg.so.0.4.0, TurboJPEG 3 API)","ffmpeg":"8.0","ffprobe":"8.0"}}
← {"type":"progress","id":"j1","stage":"load|optimize|probe|rvm|foundations|keying","p":0.42,"detail":"window 3/9"}
← {"type":"provider","id":"j1","provider":"cuda|tensorrt|tensorrt+cuda|cpu","precision":"fp16","tensorrt_requested":false,
   "fallback_reason":"...","range":"h1024-1280_w1792-2176_t1-12","cache":"build|reused","pieces":{...},"fallbacks":{...},
   "build_s":{"stage1":88.0,...}}
← {"type":"clip","id":"j1","width":1920,"height":1080,"fps":23.976,"frames":240}
← {"type":"memory","id":"j1","hann_chunk":24,"hann_stride":12,"low_vram":false,"auto":true,
   "budget_gb":13.1,"estimate_gb":9.8}
← {"type":"estimate","id":"e1","width":4096,"height":2160,"shape_w":4096,"shape_h":2176,"frames":120,
   "total_bytes":17094934528,"free_bytes":14717222912,"budget_bytes":14717222912,"budget_source":"gpu","budget_cap_gb":null,
   "provider":"cuda","estimate_basis":"onnxruntime-cuda-measured","margin_scale":1.1,"margin_gb":0.3,
   "windows":[{"hann_chunk":8,"hann_stride":4,"low_vram":true,"frames":8,"peak_bytes":9438851806,"needs_bytes":10704859534,"fits":true},
   {"hann_chunk":16,"hann_stride":8,"low_vram":true,"frames":16,"peak_bytes":16591890837,"needs_bytes":18573202468,"fits":false}]}
← {"type":"frames","id":"j1","done":120,"total":240}
← {"type":"log","id":"j1","text":"    Hann stage1: chunk=24, stride=12, ..."}
← {"type":"result","id":"j1","outputs":["/clips/out_shot/shot_alpha.mp4",...],
   "settings_file":"/clips/out_shot/shot_settings.txt","seconds":312.4}
← {"type":"error","id":"j1","code":"oom|input|assets|no-gpu|cancelled|output|engine|bad-request","message":"..."}
← {"type":"colorspaces","id":"c1","config":{"name":"ocio://studio-config-v4.0.0_aces-v2.0_ocio-v2.5","source":"request",
   "cache_id":"...","ocio":"2.5.2"},"model_space":"Linear Rec.709 (sRGB)",
   "roles":{"aces_interchange":"ACES2065-1","scene_linear":"ACEScg","data":"Raw",...},
   "colorspaces":[{"name":"ACEScg","family":"ACES","encoding":"scene-linear","isdata":false,"linear":true,
   "aliases":["ACES - ACEScg","lin_ap1","lin_ap1_scene"]},...]}
```

- `progress.p` is the stage's own fraction when the stage reports one (stage-1
  windows), otherwise absent. The app never invents a fraction. An `optimize` progress (Rust engine, additive)
  names the network being built in `piece` (`cradio`, `moge`, `rvm`, `stage1`, `stage2`, built in that order).
  In low-VRAM mode a `load` comes after the last stage-1 window (stage 2 loading); the app keeps showing keying.
- Video cutout (Rust engine, backlog row 26): no `video_codec` carries alpha, so the video cutout is three channels,
  despilled colour premultiplied in the file's own coding (sRGB-coded, or linear with `cutout_linear`, × alpha), and
  its alpha is the `alpha` output: a video job with `cutout` always writes `alpha` too (added when not asked for, a
  `log` line says so, and `result.outputs` lists it). The EXR cutout stays premultiplied RGBA. The PyTorch engine
  writes the original's straight ProRes 4444 cutout with alpha (upstream's writer, unchanged).
- `result.outputs` lists one path per output: a file (`<clip>_alpha.mp4`; `.mov` with `dnxhr444`) or, for EXR, a
  folder `<clip>_<output>_exr/` (the checker's output name is `checker_comp_despill050`, by its despill). Rust engine
  (backlog row 30): its frames are `<clip>_<output>.<number>.exr`. A frame folder's frames keep their own numbers
  (the trailing digits of each input name) and padding (at least 4); a video, or a folder where a frame has no
  number or the numbers don't strictly increase, counts from 1001 (padding 4, wider if needed; a `log` line says
  why). `_settings.txt` adds `EXR Frame Numbers: source (65-184)` or `1001-1120`. The alpha EXR holds the matte as
  channel `A` alone, the cutout is RGBA premultiplied (RGB × alpha), fg and checker RGB. The PyTorch engine
  writes the original's layout: `<output>_000000.exr` from 0, the matte as `Y`, a straight cutout.
- `frames` counts finished frames handed to every selected output's writer
  (the slowest one). The writers encode on their own threads with a queue of
  at most 2 batches, so it trails the file on disk by at most 2 frames at the
  default batch of 1. At most 4 per second, plus the last frame.
- `memory` is the window this job really uses, sent before stage 1 starts. The
  Rust engine adds `provider`, `free_gb` (what it saw), `budget_cap_gb` (the
  job's `vram_budget_gb`), `budget_source` (`gpu`, or `host` on the CPU
  provider) and `estimate_basis` (`onnxruntime-cuda-measured` since 2026-10-24: the
  estimate is this engine's measured peaks on ONNX Runtime CUDA plus 6 %, an upper bound at every measured point,
  docs/BACKLOG.md row 41; before, `pytorch-bf16-table`, the upstream runtime's PyTorch table).
- `decoders` (Rust engine pong, additive): the JPEG decoder frame folders get (libjpeg-turbo,
  the one OpenCV uses, or the image crate's, which differs by a few levels) and the ffmpeg and
  ffprobe versions. A job writes the same three at the end of its `_settings.txt`
  (`JPEG Decoder:`, `FFmpeg:`, `FFprobe:`) and in a `log` line.
- `ocio` (Rust engine pong, additive): the version of the OpenColorIO library linked into the engine ("2.5.2"). An
  engine built without it (a stub) refuses to start.
- Colour management (Rust engine, backlog row 29; docs/ENGINE_RUST.md "Colour"): with `input_colorspace` the clip's
  values are converted by OCIO (LOSSLESS, float32) to the model's linear Rec.709 before the model sees them,
  negatives kept; the foreground is despilled there and converted to `output_colorspace` for the EXR outputs. The
  alpha is never converted (byte-identical whatever the output space); the EXR cutout is premultiplied in a linear
  output space and straight (colour + alpha) in a log or display one; the checker stays as it is. The job's
  `_settings.txt` adds `OCIO:`, `OCIO Config:` (the versioned name or path, and where it came from), `OCIO Config
  Cache ID:`, `Input Colorspace:`, `Output Colorspace:` and `OCIO Optimization: LOSSLESS`, and a `log` line names
  them. Without `input_colorspace` and `output_colorspace` the job reads no config and runs as before. An unknown
  config or colour space is a `bad-request` with OCIO's message, before anything loads.
- `config` (Rust engine pong, additive): the settings the engine runs with, read once at
  startup from its command line and `CK_ENGINE_*` variables (docs/ENGINE_RUST.md "Knobs").
- `provider` (Rust engine, additive) says what really runs the job: the
  provider and precision, and for TensorRT the shape range, whether its
  engines are built or reused, and every network that fell back to CUDA, with why.
- `optimize` (Rust engine, TensorRT only) is a one-time engine build for the
  clip's shape range, one `progress` per network built (`detail`: "stage 1 (4/5)");
  the builder reports no fraction, so it has no `p`. `build_s` in the second
  `provider` reply gives each build's seconds.
- A TensorRT job with an automatic window gets the window the CUDA path would
  choose within its budget, always in low-VRAM mode (the measured table's
  normal-mode peaks are CUDA's; TensorRT's are unmeasured, backlog row 54): its
  `memory` reply is the same as a CUDA job's, with
  `estimate_basis: "onnxruntime-cuda-measured"`; the shape range is in the
  `provider` reply (`range`).
- A request the engine can't read is answered with
  `{"type":"error","code":"bad-request","message":"..."}` and the engine keeps
  running. After a job's `error` the engine also keeps running and takes the
  next job.
- `output` (Rust engine, additive): the results or the job's temporary files can't be
  written: the folder isn't writable, the drive is read-only or its disk is full (the
  message says which). Before, these were `engine`.
- Rust engine: a request line that isn't UTF-8 text, a `cancel` without an `id`, a
  `run` option outside its documented range (`hint_quality`, `carry_hint_quality`,
  `despill_strength`: 0–1; `model_scale` above 0 and at most 2; `linear_brightness` and `linear_contrast` above 0; `start_mode` one of its three; `seed` a whole number ≥ 0; for video output a `video_codec` it doesn't know, a `preset` or `pix_fmt` libx264 doesn't take, a
  `crf` outside 0–51, or 0–63 for 10-bit formats, a 4:2:0 `pix_fmt` at an odd width or height or a 4:2:2 one at an odd width (found
  once the clip is probed, before keying); `frame_dir_fps` at 0 or below) or a number that isn't finite (`"nan"`, `"inf"`) is a
  `bad-request` (for a `run`, with its id, before anything loads); the engine keeps
  reading. An option that isn't a number at all stays an `input` error.
