"""Check onnx_patches against the unpatched PyTorch model (fp32, CPU).

usage: parity_patch.py HxWxT [HxWxT ...]   (pixel sizes, multiples of 128)
Pick sizes whose /16 grid covers 1, 2 and 3+ windows per axis, with and
without the 8-token padding (grid % 16 == 8), e.g. 256x384x2 384x640x2 768x1280x2.
"""
import sys
import torch
from common import load_cpu_model
import export as ex

# loop: NOT-WORTH — the few sizes given
sizes = [tuple(int(v) for v in a.split("x")) for a in sys.argv[1:]]
model = load_cpu_model()
res = {}
# loop: SERIAL-REQUIRED — one size at a time, each a CPU forward (memory)
for (H, W, T) in sizes:
    # loop: SERIAL-REQUIRED — two pieces, one CPU forward at a time
    for piece in ("stage2", "stage1"):
        mod, args, *_ = ex.build(piece, model, H, W, T)
        with torch.no_grad():
            # loop: NOT-WORTH — a piece's few inputs
            o = mod(*[a.clone() for a in args])
        res[(piece, H, W, T)] = (mod, args, o if isinstance(o, tuple) else (o,))
from moge.model.dinov2.models import vision_transformer as _vt
_orig_ipe = _vt.DinoVisionTransformer.interpolate_pos_encoding
import onnx_patches
onnx_patches.apply()
# loop: SERIAL-REQUIRED — the recorded runs, one CPU forward at a time
for (piece, H, W, T), (mod, args, ref) in res.items():
    with torch.no_grad():
        # loop: NOT-WORTH — a piece's few inputs
        o = mod(*[a.clone() for a in args])
    o = o if isinstance(o, tuple) else (o,)
    # loop: NOT-WORTH — one comparison per output (a few)
    for i, (a, b) in enumerate(zip(ref, o)):
        d = (a - b).abs()
        print(f"PATCH_PARITY {piece} {H}x{W}x{T} grid16={H//16}x{W//16} out{i} shape={tuple(a.shape)} max_abs={d.max().item():.3e} "
              f"mean_abs={d.mean().item():.3e} ref_absmax={a.abs().max().item():.3e}")

# MoGe pos-embed patch: compare encoder features before/after at 2 shapes.
import importlib
from moge.model.dinov2.models import vision_transformer as vt
import onnx_patches as op
# loop: SERIAL-REQUIRED — three shapes, one CPU forward at a time
for (h, w) in [(168, 280), (56, 84), (252, 420)]:
    x = torch.rand(2, 3, h, w, generator=torch.Generator().manual_seed(1))
    enc = model.foundations.moge.encoder
    vt.DinoVisionTransformer.interpolate_pos_encoding = _orig_ipe
    with torch.no_grad():
        a, _ = enc(x, h // 14, w // 14, return_class_token=True)
    vt.DinoVisionTransformer.interpolate_pos_encoding = op.dinov2_interpolate_pos_encoding
    with torch.no_grad():
        b, _ = enc(x, h // 14, w // 14, return_class_token=True)
    print(f"PATCH_PARITY moge_posenc {h}x{w} max_abs={(a-b).abs().max().item():.3e} ref_absmax={a.abs().max().item():.3e}")
