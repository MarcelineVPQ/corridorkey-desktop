"""Does a 128 px side run? Upstream PyTorch fp32 (unpatched) and the ONNX set, each network, CPU.

usage: python small_side.py MODELS_DIR HxW [HxW ...]
"""
import sys
import numpy as np
import torch
import onnxruntime as ort
from common import load_cpu_model
import wrappers as wr

models = sys.argv[1]
model = load_cpu_model()
g = torch.Generator().manual_seed(0)
# loop: SERIAL-REQUIRED — one shape at a time (each runs the five pieces on the CPU)
for shp in sys.argv[2:]:
    # loop: NOT-WORTH — the two numbers of a shape
    H, W = (int(v) for v in shp.split("x"))
    T = 2
    ins = {
        "cradio": (wr.CradioPiece(model.foundations), [torch.rand(T, 3, H // 4, W // 4, generator=g)], ["rgb"]),
        "moge": (wr.MogePiece(model.foundations), [torch.rand(T, 3, H * 7 // 32, W * 7 // 32, generator=g)], ["rgb"]),
        "rvm": (wr.RvmStepPiece(model.foundations), [torch.rand(1, 3, H // 4, W // 4, generator=g),
                                                    torch.zeros(1, 1 + (H // 64) * (W // 64), 384)], ["frame", "state"]),
        "stage1": (wr.Stage1Piece(model.stage1), [torch.randn(1, T, 3, H, W, generator=g) * 0.5, torch.rand(1, T, 1, H, W, generator=g),
                                                  torch.full((1, T), 0.95), torch.randn(1, T, 768, H // 64, W // 64, generator=g),
                                                  torch.randn(1, T, model.stage1.cradio_dim, H // 64, W // 64, generator=g),
                                                  torch.randn(1, T, 384, H // 64, W // 64, generator=g)],
                   ["rgb", "hint", "hint_quality", "moge", "cradio", "rvm"]),
        "stage2": (wr.Stage2Piece(model.stage2), [torch.randn(1, 1, 3, H, W, generator=g) * 0.5,
                                                  torch.randn(1, 1, 512, H // 16, W // 16, generator=g)], ["rgb", "baton"]),
    }
    # loop: SERIAL-REQUIRED — five pieces, torch then ONNX on the CPU, one at a time (memory)
    for name, (mod, args, names) in ins.items():
        try:
            with torch.no_grad():
                out = mod.eval()(*args)
            out = out[0] if isinstance(out, tuple) else out
            t = f"ok {tuple(out.shape)}"
        except Exception as e:
            t = f"FAIL {type(e).__name__}: {str(e)[:160]}"
        try:
            s = ort.InferenceSession(f"{models}/ck2-{name}-fp32.onnx", providers=["CPUExecutionProvider"])
            # loop: NOT-WORTH — a piece's few inputs
            o = s.run(None, {n: a.numpy() for n, a in zip(names, args)})[0]
            r = f"ok {o.shape}"
        except Exception as e:
            r = f"FAIL {str(e)[-200:]}"
        print(f"SMALL {H}x{W} {name}: torch {t} | onnx {r}", flush=True)
