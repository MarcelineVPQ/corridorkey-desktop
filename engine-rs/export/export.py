"""Export one CorridorKey v2 piece to ONNX (fp32), CPU only.

usage: python export.py PIECE [--exporter dynamo|ts] [--H 768 --W 1280] [--T 4]
         [--static] [--opset 18] [--patch]

PIECE: cradio | moge | rvm | stage1 | stage2

H, W are the padded model resolution (multiple of 128 in the runtime).
Writes <scratch>/onnx/<piece>[_<tag>].onnx and a JSON log line with timing,
size and the exact error on failure.
"""
import argparse
import json
import time
import traceback
from pathlib import Path

from common import ONNX_DIR, load_cpu_model

import torch


def build(piece, model, H, W, T):
    import wrappers as wr
    g = torch.Generator().manual_seed(0)
    r = lambda *s: torch.rand(*s, generator=g)
    h64, w64 = H // 64, W // 64
    if piece == "cradio":
        mod = wr.CradioPiece(model.foundations)
        args = (r(T, 3, H // 4, W // 4),)
        names_in, names_out = ["rgb"], ["feat"]
        dyn = {"rgb": {0: "N", 2: "h4", 3: "w4"}}
    elif piece == "moge":
        mod = wr.MogePiece(model.foundations)
        args = (r(T, 3, H * 7 // 32, W * 7 // 32),)
        names_in, names_out = ["rgb"], ["feat"]
        dyn = {"rgb": {0: "N", 2: "hm", 3: "wm"}}
    elif piece == "rvm":
        mod = wr.RvmStepPiece(model.foundations)
        N = 1 + (H // 64) * (W // 64)
        args = (r(1, 3, H // 4, W // 4), torch.randn(1, N, 384, generator=g))
        names_in, names_out = ["frame", "state"], ["feat", "new_state"]
        dyn = {"frame": {2: "h4", 3: "w4"}, "state": {1: "ntok"}}
    elif piece == "stage1":
        mod = wr.Stage1Piece(model.stage1)
        args = (torch.randn(1, T, 3, H, W, generator=g) * 0.5,
                r(1, T, 1, H, W),
                torch.full((1, T), 0.95),
                torch.randn(1, T, 768, h64, w64, generator=g),
                torch.randn(1, T, model.stage1.cradio_dim, h64, w64, generator=g),
                torch.randn(1, T, 384, h64, w64, generator=g))
        names_in = ["rgb", "hint", "hint_quality", "moge", "cradio", "rvm"]
        names_out = ["baton", "aux"]
        dyn = {"rgb": {1: "T", 3: "H", 4: "W"}, "hint": {1: "T", 3: "H", 4: "W"},
               "hint_quality": {1: "T"},
               "moge": {1: "T", 3: "h64", 4: "w64"}, "cradio": {1: "T", 3: "h64", 4: "w64"},
               "rvm": {1: "T", 3: "h64", 4: "w64"}}
    elif piece == "stage2":
        mod = wr.Stage2Piece(model.stage2)
        # Traced at B=2: tracing at B=1 bakes broken batch arithmetic into the
        # reshapes (graph fails for B>1, output dims read 'B, B, 4//B').
        Bt = 2
        args = (torch.randn(1, Bt, 3, H, W, generator=g) * 0.5,
                torch.randn(1, Bt, 512, H // 16, W // 16, generator=g))
        names_in, names_out = ["rgb", "baton"], ["logits"]
        dyn = {"rgb": {1: "B", 3: "H", 4: "W"}, "baton": {1: "B", 3: "h16", 4: "w16"}}
    else:
        raise SystemExit(f"unknown piece {piece}")
    return mod.eval(), args, names_in, names_out, dyn


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("piece")
    ap.add_argument("--exporter", default="dynamo", choices=["dynamo", "ts"])
    ap.add_argument("--H", type=int, default=768)
    ap.add_argument("--W", type=int, default=1280)
    ap.add_argument("--T", type=int, default=4)
    ap.add_argument("--static", action="store_true")
    ap.add_argument("--opset", type=int, default=18)
    ap.add_argument("--patch", action="store_true",
                    help="apply onnx_patches (export-friendly shifted-window attention)")
    ap.add_argument("--tag", default="")
    ap.add_argument("--autocast16", action="store_true",
                    help="fp32 weights, export traced under fp16 autocast (mixed precision graph)")
    ap.add_argument("--half", action="store_true",
                    help="export a native fp16 graph (model.half(), fp16 inputs)")
    a = ap.parse_args()

    model = load_cpu_model()
    if a.patch:
        import onnx_patches
        onnx_patches.apply()
    mod, args, names_in, names_out, dyn = build(a.piece, model, a.H, a.W, a.T)
    if a.autocast16:
        inner = mod

        class _AC(torch.nn.Module):
            def __init__(self):
                super().__init__()
                self.inner = inner

            def forward(self, rgb):  # single-input pieces (cradio/moge)
                with torch.autocast("cpu", dtype=torch.float16):
                    return self.inner(rgb)
        mod = _AC().eval()
    elif a.half:
        mod = mod.half()
        args = tuple(x.half() for x in args)
    tag = a.tag or ("fp16" if (a.half or a.autocast16) else f"{a.exporter}{'_static' if a.static else ''}")
    out = ONNX_DIR / f"{a.piece}_{tag}.onnx"
    rec = {"piece": a.piece, "exporter": a.exporter, "static": a.static,
           "opset": a.opset, "patch": a.patch, "half": a.half, "shape": [a.T, a.H, a.W], "file": str(out)}
    t0 = time.time()
    try:
        with torch.no_grad():
            if a.exporter == "dynamo":
                ds = None
                if not a.static:
                    ds = {}
                    for n in names_in:
                        ds[n] = {k: torch.export.Dim.AUTO for k in dyn.get(n, {})}
                prog = torch.onnx.export(
                    mod, args, input_names=names_in, output_names=names_out,
                    dynamic_shapes=tuple(ds[n] for n in names_in) if ds else None,
                    opset_version=a.opset, dynamo=True, external_data=True,
                    optimize=True, verify=False)
                prog.save(str(out), external_data=True)
            else:
                torch.onnx.export(
                    mod, args, str(out), input_names=names_in, output_names=names_out,
                    dynamic_axes=None if a.static else dyn,
                    opset_version=a.opset, dynamo=False, do_constant_folding=True)
        rec["ok"] = True
    except Exception as e:  # record exact error
        rec["ok"] = False
        rec["error"] = f"{type(e).__name__}: {str(e)[:3000]}"
        traceback.print_exc()
    rec["seconds"] = round(time.time() - t0, 1)
    if rec["ok"]:
        size = sum(p.stat().st_size for p in out.parent.glob(out.name + "*"))
        data = out.with_suffix(".onnx.data")
        rec["bytes"] = size
        import onnx
        m = onnx.load(str(out), load_external_data=False)
        ops = {}
        for n in m.graph.node:
            k = (n.domain + "::" if n.domain else "") + n.op_type
            ops[k] = ops.get(k, 0) + 1
        rec["ops"] = dict(sorted(ops.items(), key=lambda kv: -kv[1]))
        rec["inputs"] = [(i.name, [d.dim_param or d.dim_value for d in i.type.tensor_type.shape.dim])
                         for i in m.graph.input]
        rec["outputs"] = [(i.name, [d.dim_param or d.dim_value for d in i.type.tensor_type.shape.dim])
                          for i in m.graph.output]
    print("EXPORT_RESULT " + json.dumps(rec))
    with open(ONNX_DIR / "export_log.jsonl", "a") as f:
        f.write(json.dumps(rec) + "\n")


if __name__ == "__main__":
    main()
