"""Run one backend over a clip and save / compare results.

usage:
  python run_parity.py torch CLIP_DIR OUT.npz [--device cpu|cuda] [--amp bf16|fp32]
  python run_parity.py ort   CLIP_DIR OUT.npz --onnx-set fp32|fp16 [--ep cpu|cuda|trt]
  python run_parity.py cmp   REF.npz TEST.npz [GT_ALPHA_DIR]
common: --frames N --chunk 8 --stride 4
"""
import argparse
import json
import time
from pathlib import Path

import numpy as np

from common import ONNX_DIR, SCRATCH


def save(path, r):
    np.savez_compressed(path, alpha=r["alpha"], fg=r["fg"].astype(np.float16),
                        info=json.dumps({k: r[k] for k in ("time", "nonfinite", "stage2_raw_absmax", "T",
                                                           "shape_hw", "native_hw", "wall", "backend",
                                                           "peak_vram_mib") if k in r}))


def load(path):
    z = np.load(path)
    return {"alpha": z["alpha"], "fg": z["fg"].astype(np.float32), "info": json.loads(str(z["info"]))}


# Marcy's cap for these runs: 12 GiB of VRAM for the whole process. ORT's
# gpu_mem_limit is per session, so it is split per network (sum 11 GiB, the rest
# is CUDA context/cuDNN workspace); torch gets an 11 GiB allocator fraction.
# gpu_guard stops the process (exit 76) if nvidia-smi ever shows >= 12 GiB.
VRAM_LIMIT = 11 * 2**30
VRAM_SPLIT_GIB = {"cradio": 2.25, "moge": 0.75, "rvm": 0.5, "stage1": 5.5, "stage2": 2.0}
_PIECES = ("cradio", "moge", "rvm", "stage1", "stage2")
ONNX_SETS = {
    # loop: NOT-WORTH — five paths, once at import
    "fp32_op18": {k: ONNX_DIR / f"{k}_dynamo.onnx" for k in _PIECES},
    # loop: NOT-WORTH — five paths, once at import
    "fp16_op18": {k: ONNX_DIR / f"{k}_fp16.onnx" for k in _PIECES},
    # loop: NOT-WORTH — five paths, once at import
    "fp32": {k: ONNX_DIR / f"{k}_op23.onnx" for k in _PIECES},
    # loop: NOT-WORTH — five paths, once at import
    "fp16": {k: ONNX_DIR / f"{k}_op23fp16.onnx" for k in _PIECES},
    # production set (build_models.sh): opset 23, mask-free Swin, MultiHeadAttention
    # loop: NOT-WORTH — five paths, once at import
    "prod_fp32": {k: SCRATCH / "models" / f"ck2-{k}-fp32.onnx" for k in _PIECES},
    # loop: NOT-WORTH — five paths, once at import
    "prod_fp16": {k: SCRATCH / "models" / f"ck2-{k}-fp16.onnx" for k in _PIECES},
}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mode")
    ap.add_argument("a")
    ap.add_argument("b")
    ap.add_argument("c", nargs="?")
    ap.add_argument("--device", default="cpu")
    ap.add_argument("--amp", default="fp32")
    ap.add_argument("--onnx-set", default="fp32")
    ap.add_argument("--ep", default="cpu")
    ap.add_argument("--frames", type=int, default=16)
    ap.add_argument("--chunk", type=int, default=8)
    ap.add_argument("--stride", type=int, default=4)
    ap.add_argument("--low-vram", action="store_true",
                    help="torch: upstream low-VRAM inference settings (exact, chunked)")
    ap.add_argument("--ort-mem-reuse-off", action="store_true",
                    help="SessionOptions.enable_mem_reuse = False (production setting, see ONNX_EXPORT.md)")
    ap.add_argument("--warmup", action="store_true",
                    help="run one untimed window first (cuDNN algo search / TRT engine build)")
    a = ap.parse_args()

    if a.mode == "cmp":
        import pipeline
        ref, test = load(a.a), load(a.b)
        out = pipeline.metrics(ref, test)
        out["ref"] = a.a
        out["test"] = a.b
        out["test_nonfinite"] = test["info"]["nonfinite"]
        if a.c:
            import cv2
            paths = sorted(Path(a.c).glob("*.png"))[:ref["alpha"].shape[0]]
            # loop: NOT-WORTH — the clip's ground-truth PNGs, read once per comparison (a test tool)
            gt = np.stack([cv2.imread(str(p), cv2.IMREAD_UNCHANGED).astype(np.float32) / 65535 for p in paths])
            out["ref_vs_gt_alpha_mae"] = float(np.abs(ref["alpha"] - gt).mean())
            out["test_vs_gt_alpha_mae"] = float(np.abs(test["alpha"] - gt).mean())
        print("PARITY " + json.dumps(out))
        return

    gpu = (a.mode == "torch" and a.device.startswith("cuda")) or (a.mode == "ort" and a.ep != "cpu")
    if a.mode == "ort" and a.ep != "cpu":
        # Load ORT's CUDA 13 / cuDNN libs before torch pulls in its CUDA 12
        # copies (cuDNN has the same soname, libcudnn.so.9, in both).
        import onnxruntime
        onnxruntime.preload_dlls()
    if gpu:
        import gpu_guard
        gpu_guard.start()
    import torch
    import pipeline
    peak = None
    if a.mode == "torch":
        from common import load_cpu_model
        model = load_cpu_model()
        amp = None if a.amp == "fp32" else torch.bfloat16
        if a.low_vram:
            from corridorkey.runtime import InferenceConfig, configure_low_vram_inference
            configure_low_vram_inference(model, InferenceConfig(low_vram=True))
        if a.device.startswith("cuda"):
            torch.cuda.set_per_process_memory_fraction(
                VRAM_LIMIT / torch.cuda.get_device_properties(0).total_memory)
            model = model.to(a.device)
            torch.cuda.reset_peak_memory_stats()
        be = pipeline.TorchBackend(model, a.device, amp)
    else:
        prov = {"cpu": ["CPUExecutionProvider"],
                "cuda": [("CUDAExecutionProvider", {"cudnn_conv_algo_search": "EXHAUSTIVE"}), "CPUExecutionProvider"],
                "trt": [("TensorrtExecutionProvider", {"trt_fp16_enable": a.onnx_set == "fp16",
                                                       "trt_engine_cache_enable": True,
                                                       "trt_engine_cache_path": str(ONNX_DIR / "trt_cache")}),
                        "CUDAExecutionProvider", "CPUExecutionProvider"]}[a.ep]
        def per_piece(piece):
            out = []
            # loop: NOT-WORTH — the two or three providers of a piece
            for p in prov:
                name, opts = (p if isinstance(p, tuple) else (p, {}))
                if name in ("CUDAExecutionProvider", "TensorrtExecutionProvider"):
                    opts = dict(opts, gpu_mem_limit=str(int(VRAM_SPLIT_GIB[piece] * 2**30))) \
                        if name == "CUDAExecutionProvider" else opts
                out.append((name, opts))
            return out
        be = pipeline.OrtBackend(ONNX_SETS[a.onnx_set], per_piece, name=f"ort-{a.ep}-{a.onnx_set}",
                                 mem_reuse=not a.ort_mem_reuse_off)
    warm_s = None
    if a.warmup:
        t = time.perf_counter()
        pipeline.run_clip(be, a.a, chunk=a.chunk, stride=a.stride, num_frames=a.chunk,
                          sync_dev=a.device if a.mode == "torch" else "cpu", log=lambda *_: None)
        warm_s = time.perf_counter() - t
    t = time.perf_counter()
    r = pipeline.run_clip(be, a.a, chunk=a.chunk, stride=a.stride, num_frames=a.frames,
                          sync_dev=a.device if a.mode == "torch" else "cpu")
    r["wall"] = time.perf_counter() - t
    r["backend"] = be.name
    if a.mode == "torch" and a.device.startswith("cuda"):
        r["torch_max_allocated_mib"] = torch.cuda.max_memory_allocated() / 2**20
    if gpu:
        r["peak_vram_mib"] = gpu_guard.peak_mib()
        gpu_guard.stop()
    save(a.b, r)
    print("RUN " + json.dumps({"warmup_s": warm_s, "onnx_set": a.onnx_set if a.mode == "ort" else None,
                               "backend": be.name, "clip": a.a, "frames": r["T"], "chunk": a.chunk,
                               "stride": a.stride, "wall_s": round(r["wall"], 2),
                               "s_per_frame": round(r["wall"] / r["T"], 3),
                               # loop: NOT-WORTH — the few timing keys of one report
                               "time": {k: round(v, 2) for k, v in r["time"].items()},
                               "nonfinite": r["nonfinite"],
                               "stage2_raw_absmax": r["stage2_raw_absmax"],
                               "peak_vram_mib": r.get("peak_vram_mib"),
                               "torch_max_allocated_mib": r.get("torch_max_allocated_mib"),
                               "host_peak_rss_gb": round(__import__("resource").getrusage(
                                   __import__("resource").RUSAGE_SELF).ru_maxrss / 1e6, 2)}))


if __name__ == "__main__":
    main()
