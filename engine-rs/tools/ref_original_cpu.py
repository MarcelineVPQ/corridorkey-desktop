#!/usr/bin/env python3
"""The original runtime itself (CorridorKey2.0 corridorkey/runtime.py run_inference), on the CPU in float32: the
reference for the engine's model scale, linear adjust and start mode (backlog rows 42 and 45; tools/e2e_scale_cpu.sh).

Run with a CorridorKey2.0 checkout's venv; the checkout is imported, never changed. What is patched, in this
process only:
  - the device: `.cuda()` stays on the CPU, torch.cuda.synchronize / empty_cache do nothing (no CUDA is touched:
    CUDA_VISIBLE_DEVICES is emptied before torch loads);
  - the networks get their bfloat16 inputs as float32 (exact; the runtime's autocast("cuda") does nothing on the CPU,
    so every network runs in float32, as the ONNX fp32 set does);
  - runtime._resize_output_torch, which upstream leaves unimplemented ("non-native scaling would need explicit
    Lanczos output rendering"), is completed with upstream's own video_io.resize_chw_lanczos, frame by frame.

  ref_original_cpu.py CK2_ROOT INPUT OUTPUT_DIR TEMP_DIR [--model_scale S] [--linear_brightness G]
      [--linear_contrast C] [--linear_contrast_pivot P] [--num_frames N] [--start_mode M] [--seed K]
      [--hann_chunk 4 --hann_stride 2] [--outputs alpha fg]
Writes EXR float sequences (the original's layout) and the original's _settings.txt.
"""
import argparse
import os
import sys
from pathlib import Path

os.environ["CUDA_VISIBLE_DEVICES"] = ""
os.environ["OPENCV_IO_ENABLE_OPENEXR"] = "1"

ap = argparse.ArgumentParser()
ap.add_argument("root")
ap.add_argument("input")
ap.add_argument("output_dir")
ap.add_argument("temp_dir")
ap.add_argument("--model_scale", type=float, default=1.0)
ap.add_argument("--linear_brightness", type=float, default=1.0)
ap.add_argument("--linear_contrast", type=float, default=1.0)
ap.add_argument("--linear_contrast_pivot", type=float, default=0.18)
ap.add_argument("--num_frames", type=int, default=-1)
ap.add_argument("--start_mode", default="begin")
ap.add_argument("--seed", type=int, default=0)
ap.add_argument("--hann_chunk", type=int, default=4)
ap.add_argument("--hann_stride", type=int, default=2)
ap.add_argument("--outputs", nargs="*", default=["alpha", "fg"])
ap.add_argument("--threads", type=int, default=8)
ap.add_argument("--bf16-area", action="store_true")
args = ap.parse_args()
sys.path.insert(0, str(Path(args.root).resolve()))

import numpy as np  # noqa: E402
import torch  # noqa: E402

from corridorkey import runtime as rt  # noqa: E402
from corridorkey import video_io as vio  # noqa: E402

torch.set_num_threads(args.threads)
torch.set_grad_enabled(False)
torch.nn.Module.cuda = lambda self, *a, **k: self
torch.cuda.synchronize = lambda *a, **k: None
torch.cuda.empty_cache = lambda *a, **k: None


def lanczos_out(x, meta):
    if tuple(meta["model_native_hw"]) == tuple(meta["output_hw"]):
        return x
    oh, ow = meta["output_hw"]
    # loop: NOT-WORTH — the frames of one stage-2 batch (1)
    return torch.from_numpy(np.stack([vio.resize_chw_lanczos(f.numpy(), (oh, ow)) for f in x.cpu()]))


rt._resize_output_torch = lanczos_out

# The runtime area-resizes the foundation models' inputs on the bfloat16 frames, in bfloat16 (its normal-mode
# _build_foundation_inputs gets the display chunk as stored); the engine (and the ONNX spike's reference,
# export/pipeline.py) resize the same bfloat16 values in float32. Measured with this harness on 448x320, model scale
# 1.0: the runtime as it is differs from the engine by alpha MAE 7e-6, max 4.6e-3; with the float32 resize below the
# check is at float32 level. --bf16-area keeps the runtime's own bfloat16 resize.
if not args.bf16_area:
    _found_inputs = rt._build_foundation_inputs
    rt._build_foundation_inputs = lambda rgb_bt: _found_inputs(rgb_bt.float())


def to_f32(_module, a, k):
    cast = lambda v: v.float() if torch.is_tensor(v) and v.is_floating_point() else v  # noqa: E731
    # loop: NOT-WORTH — a network call's few arguments
    return tuple(cast(v) for v in a), {n: cast(v) for n, v in k.items()}


paths = rt.RuntimePaths.from_package(Path(args.root).resolve(), None)
model = rt.load_model(paths, device="cpu").float().eval()
# loop: NOT-WORTH — the four networks the runtime calls
for m in (model.foundations, model.foundations.rvm, model.stage1, model.stage2):
    if m is not None:
        m.register_forward_pre_hook(to_f32, with_kwargs=True)

writer = rt.WriterConfig(ffmpeg_bin="ffmpeg", codec="libx264", crf=12, preset="medium", pix_fmt="yuv444p10le", bitrate=None, threads=2)
cfg = rt.InferenceConfig(
    hann_chunk=args.hann_chunk, hann_stride=args.hann_stride, auto_vram=False, model_scale=args.model_scale,
    num_frames=args.num_frames, start_mode=args.start_mode, seed=args.seed, low_vram=False,
    outputs=set(args.outputs), temp_dir=Path(args.temp_dir), linear_brightness=args.linear_brightness,
    linear_contrast=args.linear_contrast, linear_contrast_pivot=args.linear_contrast_pivot,
    output_format="exr", exr_dtype="float")
rt.run_inference(model, args.input, args.output_dir, cfg, writer, initial_hint_path=None, hint_video_path=None)
