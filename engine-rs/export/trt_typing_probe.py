"""Where TensorRT fp16 loses precision: build one network with TensorRT's Python API in different typing modes
and compare with the recorded fp32 reference (trt_netparity.py ref).

usage: python trt_typing_probe.py REF.npz PIECE FILE.onnx MODE [--workspace-gb 4]
MODE: weak16    weakly typed, FP16 flag (what ORT's TensorRT provider builds)
      strong    strongly typed: TensorRT follows the ONNX file's types exactly
      weak16n   weakly typed, FP16 flag, normalisation / softmax / reduce layers pinned to FP32
Prints PROBE {piece, mode, build_s, per output: max_abs, mean_abs, rel_max}.
"""
import json
import sys
import time

import numpy as np
import tensorrt as trt
import torch

INPUTS = {"rvm": ("frame", "state"), "cradio": ("rgb",), "moge": ("rgb",),
          "stage1": ("rgb", "hint", "hint_quality", "moge", "cradio", "rvm"), "stage2": ("rgb", "baton")}
TT = {trt.float32: torch.float32, trt.float16: torch.float16, trt.bfloat16: torch.bfloat16}


def main():
    ref_path, piece, f, mode = sys.argv[1:5]
    ws = float(sys.argv[sys.argv.index("--workspace-gb") + 1]) if "--workspace-gb" in sys.argv else 4.0
    ref = dict(np.load(ref_path))
    keys = sorted({k.split(".")[0] for k in ref if k.split(".")[0][:-1] == piece})
    log = trt.Logger(trt.Logger.ERROR)
    b = trt.Builder(log)
    flags = 1 << int(trt.NetworkDefinitionCreationFlag.STRONGLY_TYPED) if mode.startswith("strong") else 0
    net = b.create_network(flags)
    p = trt.OnnxParser(net, log)
    assert p.parse_from_file(f), [str(p.get_error(i)) for i in range(p.num_errors)]
    cfg = b.create_builder_config()
    cfg.set_memory_pool_limit(trt.MemoryPoolType.WORKSPACE, int(ws * 2**30))
    if mode.startswith("weak16") or mode.startswith("pin:"):
        cfg.set_flag(trt.BuilderFlag.FP16)
    # "weak": weakly typed, no FP16 flag (TF32 left on, as TensorRT defaults)
    if mode == "strong32":
        cfg.clear_flag(trt.BuilderFlag.TF32)
    if mode.startswith("pin:"):
        # FILE should be the fp32 export: the listed layer types stay FP32, the rest may run in FP16
        cfg.clear_flag(trt.BuilderFlag.TF32)
        cfg.set_flag(trt.BuilderFlag.OBEY_PRECISION_CONSTRAINTS)
        types = [getattr(trt.LayerType, t) for t in mode[4:].split("+")]
        pinned = 0
        for i in range(net.num_layers):
            L = net.get_layer(i)
            if L.type in types:
                L.precision = trt.float32
                for o in range(L.num_outputs):
                    if L.get_output_type(o) in (trt.float16, trt.float32):
                        L.set_output_type(o, trt.float32)
                pinned += 1
        print("pinned", pinned)
    if mode == "weak16n":
        cfg.set_flag(trt.BuilderFlag.OBEY_PRECISION_CONSTRAINTS)
        pinned = 0
        for i in range(net.num_layers):
            L = net.get_layer(i)
            if L.type in (trt.LayerType.NORMALIZATION, trt.LayerType.SOFTMAX, trt.LayerType.REDUCE):
                L.precision = trt.float32
                for o in range(L.num_outputs):
                    L.set_output_type(o, trt.float32)
                pinned += 1
        print("pinned", pinned)
    k0 = keys[0]
    prof = b.create_optimization_profile()
    for n in INPUTS[piece]:
        shp = ref[f"{k0}.in.{n}"].shape
        prof.set_shape(n, shp, shp, shp)
    cfg.add_optimization_profile(prof)
    t = time.perf_counter()
    blob = b.build_serialized_network(net, cfg)
    build_s = time.perf_counter() - t
    assert blob is not None, "build failed"
    eng = trt.Runtime(log).deserialize_cuda_engine(blob)
    ctx = eng.create_execution_context()
    res = {}
    for k in keys:
        bufs = {}
        for n in INPUTS[piece]:
            x = torch.from_numpy(ref[f"{k}.in.{n}"]).to(TT[eng.get_tensor_dtype(n)]).cuda().contiguous()
            ctx.set_input_shape(n, tuple(x.shape))
            bufs[n] = x
        outs = [eng.get_tensor_name(i) for i in range(eng.num_io_tensors)
                if eng.get_tensor_mode(eng.get_tensor_name(i)) == trt.TensorIOMode.OUTPUT]
        for n in outs:
            bufs[n] = torch.empty(tuple(ctx.get_tensor_shape(n)), dtype=TT[eng.get_tensor_dtype(n)], device="cuda")
        for n, v in bufs.items():
            ctx.set_tensor_address(n, v.data_ptr())
        s = torch.cuda.current_stream()
        assert ctx.execute_async_v3(s.cuda_stream)
        s.synchronize()
        times = []
        for _ in range(5):
            t1 = time.perf_counter()
            ctx.execute_async_v3(s.cuda_stream)
            s.synchronize()
            times.append(time.perf_counter() - t1)
        res[f"{k}.ms"] = round(1000 * float(np.median(times)), 2)
        for i, n in enumerate(outs):
            o = bufs[n].float().cpu().numpy()
            r = ref[f"{k}.out{i}"]
            d = np.abs(o - r)
            res[f"{k}.out{i}"] = {"max_abs": float(d.max()), "mean_abs": float(d.mean()),
                                  "rel_max": float(d.max() / max(np.abs(r).max(), 1e-12))}
    print("PROBE " + json.dumps({"piece": piece, "mode": mode, "build_s": round(build_s, 1), "res": res}))


if __name__ == "__main__":
    main()
