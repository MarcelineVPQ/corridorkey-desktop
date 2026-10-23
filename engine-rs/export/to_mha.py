"""Rewrite ONNX `Attention` (opset 23) nodes to com.microsoft::MultiHeadAttention.

usage: python to_mha.py IN.onnx OUT.onnx [PIECE]

Also drops all intermediate value_info (see main()).

With PIECE (cradio|moge|rvm|stage1|stage2) the exporter's opaque dim symbols
(s34, s32, ...) are renamed everywhere in the graph to the names used in
docs/ONNX_EXPORT.md (T, H, W, ...), so the engine sees readable shapes.

Why: ORT 1.31 runs the standard opset-23 `Attention` op unfused, so it
materializes the full (B, heads, Sq, Skv) score tensor (fp32 even for fp16
graphs). `MultiHeadAttention` has fused kernels: flash attention on the CPU EP
(fp32 and fp16, no mask), and on CUDA flash (fp16, no mask/bias), cuDNN SDPA
(fp16/bf16, sm90+) or memory-efficient CUTLASS (fp32/fp16). Measured on CPU
at S=8192, 8 heads: Attention-23 peak RSS 2.31 GB (fp32) / 5.48 GB (fp16),
MHA 0.20 / 0.23 GB.

Only mask-free, non-causal, default-scale 4D nodes (Q/K/V = (B, heads, S, d)
with static heads and d) are rewritten; anything else is left alone and
reported. Each node becomes
  Transpose(0,2,1,3) -> Reshape(0,0,heads*d)  for Q, K, V
  MultiHeadAttention(num_heads=heads)
  Reshape(0,0,heads,d) -> Transpose(0,2,1,3)  back to the original output.
"""
import sys
from pathlib import Path

import numpy as np
import onnx
from onnx import helper, numpy_helper


def _shape(vi, name):
    v = vi.get(name)
    if v is None:
        return None
    return [d.dim_param or d.dim_value for d in v.type.tensor_type.shape.dim]


def convert(model):
    g = model.graph
    vi = {v.name: v for v in list(g.value_info) + list(g.input) + list(g.output)}
    new_nodes, n_conv, skipped = [], 0, []
    consts = {}

    def const(vals):
        key = tuple(vals)
        if key not in consts:
            name = f"mha_shape_{'_'.join(str(v) for v in vals)}"
            g.initializer.append(numpy_helper.from_array(np.array(vals, np.int64), name))
            consts[key] = name
        return consts[key]

    for n in g.node:
        attrs = {a.name: helper.get_attribute_value(a) for a in n.attribute}
        ok = (n.op_type == "Attention" and n.domain in ("", "ai.onnx")
              and len([i for i in n.input if i]) == 3 and len(n.input) == 3
              and len([o for o in n.output if o]) == 1
              and attrs.get("is_causal", 0) == 0 and "scale" not in attrs
              and attrs.get("softcap", 0.0) == 0.0 and attrs.get("qk_matmul_output_mode", 0) == 0)
        sq = _shape(vi, n.input[0]) if ok else None
        sk = _shape(vi, n.input[1]) if ok else None
        sv = _shape(vi, n.input[2]) if ok else None
        if ok and not (sq and sk and sv and len(sq) == 4 and isinstance(sq[1], int) and isinstance(sq[3], int)
                       and sk[1] == sq[1] and sv[1] == sq[1] and sk[3] == sq[3] and sv[3] == sq[3]):
            ok = False
        if not ok:
            if n.op_type == "Attention":
                skipped.append(n.name)
            new_nodes.append(n)
            continue
        heads, d = sq[1], sq[3]
        p = f"{n.name or 'attn'}_mha{n_conv}"
        flat = []
        for j, x in enumerate(n.input):
            t, r = f"{p}_t{j}", f"{p}_r{j}"
            new_nodes.append(helper.make_node("Transpose", [x], [t], perm=[0, 2, 1, 3], name=t))
            new_nodes.append(helper.make_node("Reshape", [t, const([0, 0, heads * d])], [r], name=r))
            flat.append(r)
        o3, o4 = f"{p}_o3", f"{p}_o4"
        new_nodes.append(helper.make_node("MultiHeadAttention", flat, [o3], domain="com.microsoft",
                                          num_heads=heads, name=f"{p}"))
        new_nodes.append(helper.make_node("Reshape", [o3, const([0, 0, heads, d])], [o4], name=o4))
        new_nodes.append(helper.make_node("Transpose", [o4], [n.output[0]], perm=[0, 2, 1, 3],
                                          name=f"{p}_out"))
        n_conv += 1
    del g.node[:]
    g.node.extend(new_nodes)
    if not any(o.domain == "com.microsoft" for o in model.opset_import):
        model.opset_import.append(helper.make_opsetid("com.microsoft", 1))
    return n_conv, skipped


DIM_NAMES = {
    "cradio": {"rgb": {0: "N", 2: "H4", 3: "W4"}},
    "moge": {"rgb": {0: "N", 2: "HM", 3: "WM"}},
    "rvm": {"frame": {2: "H4", 3: "W4"}, "state": {1: "NTOK"}},
    "stage1": {"rgb": {1: "T", 3: "H", 4: "W"}, "moge": {3: "H64", 4: "W64"}},
    "stage2": {"rgb": {1: "B", 3: "H", 4: "W"}, "baton": {3: "H16", 4: "W16"}},
}


def rename_dims(model, piece):
    import re
    g = model.graph
    ren = {}
    for i in g.input:
        for ax, name in DIM_NAMES.get(piece, {}).get(i.name, {}).items():
            d = i.type.tensor_type.shape.dim[ax]
            if re.fullmatch(r"s\d+", d.dim_param or "") and d.dim_param not in ren:
                ren[d.dim_param] = name
    if not ren:
        return ren
    pat = re.compile(r"\b(" + "|".join(sorted(ren, key=len, reverse=True)) + r")\b")
    for v in list(g.input) + list(g.output) + list(g.value_info):
        for d in v.type.tensor_type.shape.dim:
            if d.dim_param:
                d.dim_param = pat.sub(lambda mt: ren[mt.group(1)], d.dim_param)
    return ren


def main():
    src, dst = Path(sys.argv[1]), Path(sys.argv[2])
    m = onnx.load(str(src), load_external_data=True)
    n, skipped = convert(m)
    if len(sys.argv) > 3:
        print("TO_MHA dims", rename_dims(m, sys.argv[3]))
    # Drop the exporter's intermediate value_info. With it, ORT's memory-reuse
    # planner holds ~4x the graph's live tensors on these dynamic-shape graphs
    # (stage-1 encoder prefix, 1280x768 T=4, CPU: run 1.18 GB with it, 0.28 GB
    # without; same as SessionOptions.enable_mem_reuse=False, which the C API /
    # Rust `ort` cannot set). Graph input/output dims are kept.
    n_vi = len(m.graph.value_info)
    del m.graph.value_info[:]
    print(f"TO_MHA dropped value_info entries: {n_vi}")
    for f in (dst, dst.with_name(dst.name + ".data")):
        if f.exists():
            f.unlink()
    onnx.save(m, str(dst), save_as_external_data=True, all_tensors_to_one_file=True,
              location=dst.name + ".data", size_threshold=1024)
    print(f"TO_MHA {src.name} -> {dst.name}: converted={n} skipped={len(skipped)} {skipped[:5]}")


if __name__ == "__main__":
    main()
