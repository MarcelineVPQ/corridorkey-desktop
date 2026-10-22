# Engine protocol (protocol 1)

Same pattern as Sonata's alignment helper (sonata-engine `align/server.py`,
`docs/LEVEL2-ALIGN.md` "Helper protocol"): the app spawns the engine and they
talk in **JSON lines**, one JSON object per line, UTF-8.

- **stdin:** requests (`"cmd"`).
- **stdout:** ONLY protocol replies (`"type"`). The model's own prints arrive as
  `log` replies.
- **stderr:** logs, tracebacks and library warnings. The app keeps the last
  lines for an error report and never parses them.

Any engine that speaks this protocol works with the app: the PyTorch engine
today (`engine/ck_engine.py`, run with the CorridorKey2.0 checkout's venv and `--package-root`), an ONNX Runtime engine if the spike
(`docs/ONNX_SPIKE.md` on the `spike/onnx` branch of the CorridorKey2.0 clone) says it is worth it.

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
waiting removes it (reply: error code `cancelled`). The running job cannot be
interrupted inside a window, so **cancelling the running job means the app
kills the engine** (SIGKILL; this is a Python process, not Electron). Each job
writes its temporary files into its own `temp_dir`, which the app deletes after
a kill.

## Requests

```
→ {"cmd":"ping"}
→ {"cmd":"run","id":"j1","input":"/clips/shot.mp4","output_dir":"/clips/out_shot",
   "temp_dir":"/home/u/.cache/corridorkey-desktop/jobs/j1","options":{...}}
→ {"cmd":"cancel","id":"j2"}
→ {"cmd":"quit"}
```

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
← {"type":"progress","id":"j1","stage":"load|probe|rvm|foundations|keying","p":0.42,"detail":"window 3/9"}
← {"type":"clip","id":"j1","width":1920,"height":1080,"fps":23.976,"frames":240}
← {"type":"memory","id":"j1","hann_chunk":24,"hann_stride":12,"low_vram":false,"auto":true,
   "budget_gb":13.1,"estimate_gb":9.8}
← {"type":"frames","id":"j1","done":120,"total":240}
← {"type":"log","id":"j1","text":"    Hann stage1: chunk=24, stride=12, ..."}
← {"type":"result","id":"j1","outputs":["/clips/out_shot/shot_alpha.mp4",...],
   "settings_file":"/clips/out_shot/shot_settings.txt","seconds":312.4}
← {"type":"error","id":"j1","code":"oom|input|assets|no-gpu|cancelled|engine","message":"..."}
```

- `progress.p` is the stage's own fraction when the stage reports one (stage-1
  windows), otherwise absent. The app never invents a fraction.
- `frames` counts finished frames handed to every selected output's writer
  (the slowest one). The writers encode on their own threads with a queue of
  at most 2 batches, so it trails the file on disk by at most 2 frames at the
  default batch of 1. At most 4 per second, plus the last frame.
- `memory` is the window this job really uses, sent before stage 1 starts.
- A request the engine can't read is answered with
  `{"type":"error","code":"bad-request","message":"..."}` and the engine keeps
  running. After a job's `error` the engine also keeps running and takes the
  next job.
