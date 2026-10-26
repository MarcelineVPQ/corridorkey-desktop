"""Host memory of one ORT CPU session for one call.

usage: ort_mem.py PIECE H W T [tag] [--no-arena] [--twice]
  loads <scratch>/onnx/<PIECE>_<tag>.onnx (or <tag>.onnx if PIECE is "file")
env: ORT_OPT=none|basic|ext|all  ORT_THREADS=n  ORT_NOPATTERN=1  ORT_NOREUSE=1

Prints
  load_rss_gb   RSS after session creation (weights, prepacked kernels)
  pre_run_gb    RSS after the input arrays exist, right before run()
  run_peak_gb   highest RSS sampled every ~0.5 ms during run()
  run_delta_gb  run_peak - pre_run: what the ORT run itself needs
  maxrss_gb     the process high-water mark (includes feed construction)
For a truthful run_delta use --no-arena and MALLOC_MMAP_THRESHOLD_=1048576,
so freed buffers go back to the OS instead of staying in an arena/heap.
"""
import os
import resource
import sys
import threading
import time

import numpy as np
import onnxruntime as ort
from common import ONNX_DIR

piece, H, W, T = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4])
tag = sys.argv[5] if len(sys.argv) > 5 and not sys.argv[5].startswith("--") else "op23"
so = ort.SessionOptions()
if os.environ.get("ORT_OPT"):
    so.graph_optimization_level = {"none": ort.GraphOptimizationLevel.ORT_DISABLE_ALL,
                                   "basic": ort.GraphOptimizationLevel.ORT_ENABLE_BASIC,
                                   "ext": ort.GraphOptimizationLevel.ORT_ENABLE_EXTENDED,
                                   "all": ort.GraphOptimizationLevel.ORT_ENABLE_ALL}[os.environ["ORT_OPT"]]
if os.environ.get("ORT_NOPATTERN"):
    so.enable_mem_pattern = False
if os.environ.get("ORT_NOREUSE"):
    so.enable_mem_reuse = False
if os.environ.get("ORT_ORDER"):
    so.execution_order = getattr(ort.ExecutionOrder, os.environ["ORT_ORDER"])
if os.environ.get("ORT_THREADS"):
    so.intra_op_num_threads = int(os.environ["ORT_THREADS"])
if "--no-arena" in sys.argv:
    so.enable_cpu_mem_arena = False

_PG = os.sysconf("SC_PAGE_SIZE")


def cur_rss():
    with open("/proc/self/statm") as f:
        return int(f.read().split()[1]) * _PG / 1e9


# tag "prod_fp32"/"prod_fp16" = the production file in <scratch>/models
path = (ONNX_DIR.parent / "models" / f"ck2-{piece}-{tag[5:]}.onnx" if tag.startswith("prod_")
        else ONNX_DIR / f"{piece}_{tag}.onnx")
s = ort.InferenceSession(str(path), so, providers=["CPUExecutionProvider"])
load_rss = cur_rss()
# loop: NOT-WORTH — one session's few inputs
in_dt = {i.name: (np.float16 if i.type == "tensor(float16)" else np.float32) for i in s.get_inputs()}
r = np.random.default_rng(0)
h64, w64 = H // 64, W // 64


def rnd(*shape, scale=1.0):
    return (r.standard_normal(shape, dtype=np.float32) * scale)


def uni(*shape):
    return r.random(shape, dtype=np.float32)


if piece == "cradio":
    feeds = {"rgb": uni(T, 3, H // 4, W // 4)}
elif piece == "moge":
    feeds = {"rgb": uni(T, 3, H * 7 // 32, W * 7 // 32)}
elif piece == "rvm":
    feeds = {"frame": uni(1, 3, H // 4, W // 4), "state": np.zeros((1, 1 + h64 * w64, 384), np.float32)}
elif piece == "stage1":
    feeds = {"rgb": rnd(1, T, 3, H, W, scale=0.5), "hint": np.zeros((1, T, 1, H, W), np.float32),
             "hint_quality": -np.ones((1, T), np.float32), "moge": rnd(1, T, 768, h64, w64),
             "cradio": rnd(1, T, 1152, h64, w64), "rvm": rnd(1, T, 384, h64, w64)}
elif piece == "stage2":
    feeds = {"rgb": rnd(1, 1, 3, H, W, scale=0.5), "baton": rnd(1, 1, 512, H // 16, W // 16)}
else:
    raise SystemExit(f"unknown piece {piece}")
# loop: NOT-WORTH — the few feeds, one cast each, once
feeds = {k: v.astype(in_dt[k]) for k, v in feeds.items() if k in in_dt}


def run_sampled():
    peak = [0.0]
    stop = threading.Event()

    def loop():
        # loop: SERIAL-REQUIRED — the RSS sampler while one run runs, a 0.5 ms sleep per sample (below); ends on stop
        while not stop.is_set():
            peak[0] = max(peak[0], cur_rss())
            # loop: SERIAL-REQUIRED — the sampler's interval: fine enough to catch the run's peak, not a spin
            time.sleep(0.0005)
    # loop: SERIAL-REQUIRED — one sampler thread beside the measured run
    th = threading.Thread(target=loop)
    pre = cur_rss()
    th.start()
    t = time.time()
    s.run(None, feeds)
    dt = time.time() - t
    stop.set()
    # loop: SERIAL-REQUIRED — joins the sampler [bounded: stop is set just before; it ends at its next 0.5 ms check]
    th.join()
    return pre, max(peak[0], cur_rss()), dt


pre, peak, dt = run_sampled()
if "--twice" in sys.argv:
    pre2, peak2, dt2 = run_sampled()
    print(f"ORT_MEM_RUN2 pre_run_gb={pre2:.2f} run_peak_gb={peak2:.2f} run_delta_gb={peak2 - pre2:.2f} run_s={dt2:.1f}")
print(f"ORT_MEM {piece} {tag} H={H} W={W} T={T} load_rss_gb={load_rss:.2f} pre_run_gb={pre:.2f} "
      f"run_peak_gb={peak:.2f} run_delta_gb={peak - pre:.2f} "
      f"maxrss_gb={resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1e6:.2f} run_s={dt:.1f}")
