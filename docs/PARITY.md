# Parity with the original's command line

Every option of CorridorKey 2.0's `infer.py` (and the runtime settings behind it, `corridorkey/runtime.py`
`InferenceConfig` / `WriterConfig`) with its verdict in this app's Rust engine: **ported** (with the test that
checks it), **different by design** (with the reason), **not applicable**, or **row 26** (the video codec work).
The rule (backlog row 45, Marcy 2026-10-24): every option of the reference gets a verdict. Protocol names are in
docs/ENGINE_PROTOCOL.md; "app" says where the app exposes it.

Tests named below: `engine-rs/crates/ck-core/tests/parity.rs` (the ported math against the original's own functions,
fixtures from `engine-rs/tools/gen_fixtures.py`), the crate's unit tests (`cargo test`), `tools/e2e_cpu.sh` and
`tools/e2e_scale_cpu.sh` (end to end on the CPU in float32 against PyTorch float32).

## Model scale, linear adjust, start mode (backlog rows 42 and 45, 2026-10-25)

**`--model_scale`: ported.** The original resizes each frame to `scaled_hw` (each side × the scale, Python's round,
half to even, at least 1) with cv2 Lanczos-4 before padding, and its hints to the same size. Its render step then
stops: `_resize_output_torch` raises "optimized runtime render path requires native model_scale=1.0; non-native
scaling would need explicit Lanczos output rendering", so the original's own CLI cannot finish a job at any scale but
1.0. The engine completes it the way the original prepares it: upstream's own helper `video_io.resize_chw_lanczos`
(cv2 Lanczos-4) at the points where the original calls `_resize_output_torch` (the clamped alpha; for EXR the
inverse-adjusted linear foreground; for video the sRGB-encoded foreground and, with `cutout_linear`, the despilled
linear colour); everything after runs at the native size, as before. The reference for that completion is the
original's runtime with exactly that helper patched in (`engine-rs/tools/ref_original_cpu.py`).
- cv2 Lanczos-4 ported bit for bit (OpenCV's coefficient arithmetic, its source position `1 / (out / in)`, its
  summation order including the 4-wide SIMD order of the vertical pass): `lanczos4_bit_for_bit` (six cases, 1 and 3
  channels, up and down: every value identical, every bit), `resamplers` (the older fixtures, now at tolerance 0).
  Measured against cv2 4.11 on x86-64; another CPU's cv2 build (an ARM Mac's NEON with fused multiply-add) may round
  differently in the last bit: not measured.
- Frames at a scale (video, frame folder PNG, scene-linear EXR), hints (video hint frames, first-frame matte at the
  clip's size): `video_frames_at_a_model_scale_and_adjusted`, `folder_frames_at_a_model_scale`,
  `hints_at_a_model_scale` (bfloat16 views identical to the original's tensors).
- The render at a scale (up 30×44 → 45×66, down → 20×29; video uint16 and EXR float; with the linear adjust):
  `render_at_a_model_scale_with_the_linear_adjust` (EXR identical; video within one 16-bit step, as the native render).
- `scaled_hw` rounding: `clip::tests::scaled_sizes_round_like_python`; the pad of the scaled size: `shape_and_pad`.
- End to end, CPU fp32 against the original's runtime (`tools/e2e_scale_cpu.sh`, 448×320 clip, window 4/2, EXR
  float): scale 0.5 on H.264 alpha MAE 2.59e-7, max 7.9e-5; scale 0.75 on the frame folder 2.43e-7, max 6.8e-4; no
  pixel off by 1/255; fg PSNR 114-121 dB.
- `_settings.txt` writes the real value (`Model Scale: 0.5`; it said 1.0 always). The `estimate` command (row 41)
  takes `model_scale` and estimates the scaled, padded size.
- Range: the original takes any scale above 0; the engine takes above 0 up to 2.0 (2.0 = 4× the pixels: a 4K clip
  at 2.0 is 8K inside the networks); a scale whose padded size is 128 px or less on a side is refused in words, as at
  1.0. App: per clip, Queue → Internal resolution: Full / ¾ / ½ / ¼ (the plugin's choices), with the size the networks
  run at; the Manual memory picker's estimate follows it. The PyTorch reference engine refuses any scale but 1.0 up
  front (`input` error) instead of failing after its RVM pass; the app shows Full only with it.

**`--linear_brightness`, `--linear_contrast`, `--linear_contrast_pivot`: ported.** `gain * (pivot + contrast *
(linear - pivot))` on the model's linear input, its inverse on the decoded foreground, float32 as numpy and torch run
them; with the adjust on, the foundation models get `linear_to_vfm_sdr` of the adjusted linear instead of the display
frame, as the original. Identity when brightness and contrast are both within 1e-6 of 1 (checked on the doubles, as
Python). As in the original, **video inputs only**: its frame-folder probe fixes the adjust at the identity, so a
folder job runs without it (a `log` line says so; `_settings.txt` writes the requested values, as the original does,
and adds `Linear Adjust Applied: False`). Tests: `linear_adjust_both_ways` (identical), `video_frames_at_a_model_scale_and_adjusted`,
the render test above; end to end (`e2e_scale_cpu.sh` s2: brightness 1.4, contrast 1.2): alpha MAE 1.88e-7, max
1.1e-4. Different by design: brightness and contrast at 0 or below are a `bad-request` (the original divides by both:
0 gives infinite colour). App: per video clip, Queue → Linear exposure (brightness 0.25-4, contrast 0.5-2, pivot
0.01-1, shown while contrast is not 1; the original has no ranges, these are the app's); frame-folder clips don't
show the section, since the original ignores it there.

**`--start_mode` (begin / middle / random_middle) and `--seed`: ported (engine protocol), not in the app.** What
they change: only which frames of a **video** a job reads when `--num_frames` takes part of it. `middle` starts at
(total − n) // 2; `random_middle` at `np.random.default_rng(seed).integers(max_start // 4, 3 * max_start // 4 + 1)`;
frame folders always start at 0; a hint video starts at the same frame (and must have start + n frames). Ported:
the start frame (`clip::tests::start_frames_like_probe_video_meta`), NumPy's generator bit for bit (SeedSequence,
PCG64, Lemire's bounded draw: `numpy_integers`, 376 draws over 47 seeds up to 2^64 − 1 and ranges up to 2^40,
identical), the decoder starting there (ffmpeg's `trim`, frames counted as decoded; end to end `e2e_scale_cpu.sh` s4:
6 of 12 frames, random_middle, seed 3, start frame 4 in both, alpha MAE 4.03e-7, max 8.0e-4). `_settings.txt`
writes the mode and seed and adds `Start Frame:`. Not in the app: the app always keys whole clips (it sends no
`num_frames`), and there the original's start mode changes nothing either: a control would do nothing.

**`--stage2_batch` and the five `--low_vram_*` knobs: different by design, not yet measured.**
- `--stage2_batch` (default 1): the engine runs stage 2 one frame at a time, the original's default; not adjustable.
- `--low_vram_foundation_chunk` (default 4): the engine's low-memory foundation pass uses chunks of 4, the default;
  not adjustable.
- `--low_vram_mlp_chunk_tokens`, `--low_vram_enc_frame_chunk`, `--low_vram_swin_window_batch`,
  `--low_vram_full_attn_query_chunk_tokens`: how the PyTorch modules split the same arithmetic into pieces inside
  the networks to save graphics memory (configure_low_vram_inference). The ONNX networks run whole and ONNX Runtime
  plans their memory; there is no such split to set, and the engine picks its window from free memory itself.
- Not measured: whether the engine is equal to or better than the original with these knobs tuned (speed and peak
  memory). Follow-up in backlog row 45: measure the original's low-VRAM mode with a few settings of the four
  tiling knobs against the engine's low-memory mode on the HD and 4K plates (peak memory, seconds, mattes).

## Every option of infer.py

| option (default) | verdict | protocol / app | test or reason |
|---|---|---|---|
| `--input` | ported | `input`; app: the clip | e2e_cpu.sh, e2e_scale_cpu.sh |
| `--output_dir` | ported | `output_dir`; app: the clip's output folder (staged in `.corridorkey-partial`) | protocol tests |
| `--weights` | different by design | engine `--models DIR` | the engine runs the exported ONNX networks (docs/ONNX_EXPORT.md), not the PyTorch checkpoint |
| `--hint_first_frame` | ported | `hint_first_frame`; app: Hint → First-frame matte | e2e_cpu.sh v1; `hints_at_a_model_scale` |
| `--hint_video` | ported | `hint_video`; app: Hint → Hint video | e2e_cpu.sh v2; `hint_frame_preprocessing` |
| `--hint_quality` (0.95) | ported | `hint_quality`; app: Hint trust | job tests |
| `--carry_hint_quality` (0.95) | ported | `carry_hint_quality` (protocol only) | job tests |
| `--no_carry_hint` | ported | `carry_hint: false`; app: Carry | job tests |
| `--hann_chunk`, `--hann_stride` (auto) | ported | `hann_chunk`, `hann_stride`; app: Graphics memory → Manual | `windows_and_vram_table`, pipeline tests |
| `--native_resolution` | not applicable | — | accepted and ignored by the original ("native resolution is always used") |
| `--low_vram` | ported | `low_vram`; app: Low-memory mode | e2e_cpu.sh p2 (identical to normal mode) |
| `--temp_dir` | ported | `temp_dir` (per job; the app makes and removes it) | protocol tests |
| `--outputs` (alpha fg) | ported | `outputs`; app: Outputs → Files | job tests. The aliases `raw_fg` / `foreground` are not taken (protocol names only) |
| `--num_frames` (−1) | ported | `num_frames` (protocol only; the app keys whole clips) | e2e_scale_cpu.sh |
| `--start_mode` (begin) | ported | `start_mode` (protocol only) | see above |
| `--seed` (0) | ported | `seed` (protocol only) | `numpy_integers` |
| `--model_scale` (1.0) | ported | `model_scale`; app: Internal resolution | see above |
| `--frame_dir_fps` (24) | ported | `frame_dir_fps`; app: Frame folder → Frame rate | job tests |
| `--frame_dir_linear` | ported | `frame_dir_linear`; app: Frame folder → Color | e2e (linear EXR plates) |
| `--cutout_linear` | ported | `cutout_linear`; app: Cutout color | `render_paths` |
| `--despill_strength` (0.5) | ported | `despill_strength`; app: Despill | `despill_strengths` |
| `--linear_brightness` (1.0) | ported | `linear_brightness`; app: Linear exposure | see above |
| `--linear_contrast` (1.0) | ported | `linear_contrast`; app: Linear exposure | see above |
| `--linear_contrast_pivot` (0.18) | ported | `linear_contrast_pivot`; app: Linear exposure | see above |
| `--output_format` (video) | ported | `output_format`; app: Format | `render_paths` |
| `--exr_dtype` (half) | ported | `exr_dtype`; app: EXR pixel type | writer tests |
| `--ffmpeg_bin` (ffmpeg) | different by design | — | the engine runs `ffmpeg` from the PATH; the app checks it (Engine page) |
| `--ffmpeg_codec` (libx264) | row 26 | `video_codec`; app: Codec | lossless H.264 / DNxHR 444 / the original's H.264 CRF 12, measured against EXR (README Quality) |
| `--crf` (12) | ported | `crf` (with `h264-crf12`) | job tests |
| `--preset` (medium) | ported | `preset` | job tests |
| `--pix_fmt` (yuv444p10le) | ported | `pix_fmt` (with `h264-crf12`) | job tests |
| `--bitrate` (none) | row 26 | — | a bitrate cap is a lossy delivery setting; the codec choices of row 26 replace it |
| `--ffmpeg_threads` (2) | different by design | — | fixed at the original's 2 per writer |
| `--stage2_batch` (1) | different by design | — | see above (the default, fixed) |
| `--low_vram_foundation_chunk` (4) | different by design | — | see above (the default, fixed) |
| `--low_vram_mlp_chunk_tokens` (65536) | different by design | — | see above (no such split in the ONNX networks) |
| `--low_vram_enc_frame_chunk` (1) | different by design | — | see above |
| `--low_vram_swin_window_batch` (16) | different by design | — | see above |
| `--low_vram_full_attn_query_chunk_tokens` (2048) | different by design | — | see above |

Runtime settings with no flag: `shape_quantum` 128 (the same, fixed: `shape_and_pad`), `auto_vram` (on when no
window is given, as infer.py decides it: job tests), the automatic window's PyTorch table (identical:
`windows_and_vram_table`; row 41 measured how far it is from ONNX Runtime's real peaks).

## Noticed while checking (not changed)

- The original's normal-mode window area-resizes the foundation models' inputs on the bfloat16 frames in bfloat16
  (`_build_foundation_inputs` gets the stored display chunk); the engine resizes the same values in float32. Measured
  with `ref_original_cpu.py --bf16-area` against the engine on the 448×320 clip at scale 1.0, CPU fp32: alpha MAE
  7.0e-6, max 4.6e-3, fg PSNR 87 dB; with the float32 resize 1.3e-7, max 8.0e-5. The end-to-end checks above use
  the float32 resize so they compare at float32 level.
