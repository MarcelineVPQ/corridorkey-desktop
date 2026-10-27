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

Only non-causal, default-scale 4D nodes (Q/K/V = (B, heads, S, d) with static
heads and d), mask-free or with an additive float mask (set 2.0.0-onnx.5's
stage-2 Swin mask; it becomes MHA's attention_bias), are rewritten; anything
else is left alone and reported. A mask turns CUDA flash attention off (MHA
then uses memory-efficient attention). Each node becomes
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
    # loop: NOT-WORTH — one value's few dims
    return [d.dim_param or d.dim_value for d in v.type.tensor_type.shape.dim]


def vi_type(vi, name):
    v = vi.get(name)
    return v.type.tensor_type.elem_type if v is not None else None


def convert(model):
    g = model.graph
    # loop: NOT-WORTH — one pass over the graph's typed values, offline
    vi = {v.name: v for v in list(g.value_info) + list(g.input) + list(g.output)}
    new_nodes, n_conv, skipped = [], 0, []
    consts = {}

    def const(vals):
        key = tuple(vals)
        if key not in consts:
            # loop: NOT-WORTH — a shape's few values
            name = f"mha_shape_{'_'.join(str(v) for v in vals)}"
            g.initializer.append(numpy_helper.from_array(np.array(vals, np.int64), name))
            consts[key] = name
        return consts[key]

    # loop: NOT-WORTH — one pass over the graph's nodes, offline (an export step)
    for n in g.node:
        # loop: NOT-WORTH — one node's few attributes
        attrs = {a.name: helper.get_attribute_value(a) for a in n.attribute}
        # Q, K, V and an optional additive float mask (B or 1, 1 or heads, Sq, Skv): MHA's attention_bias
        mask = n.input[3] if len(n.input) == 4 and n.input[3] else None
        ok = (n.op_type == "Attention" and n.domain in ("", "ai.onnx")
              # loop: NOT-WORTH — one node's few inputs
              and all(n.input[:3]) and len(n.input) == (4 if mask else 3)
              and (mask is None or vi_type(vi, mask) in (onnx.TensorProto.FLOAT, onnx.TensorProto.FLOAT16))
              # loop: NOT-WORTH — one node's few outputs
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
        # loop: NOT-WORTH — one Attention node's three inputs
        for j, x in enumerate(n.input[:3]):
            t, r = f"{p}_t{j}", f"{p}_r{j}"
            new_nodes.append(helper.make_node("Transpose", [x], [t], perm=[0, 2, 1, 3], name=t))
            new_nodes.append(helper.make_node("Reshape", [t, const([0, 0, heads * d])], [r], name=r))
            flat.append(r)
        o3, o4 = f"{p}_o3", f"{p}_o4"
        if mask:
            flat += ["", "", mask]  # bias, key_padding_mask unused; attention_bias = the mask
        new_nodes.append(helper.make_node("MultiHeadAttention", flat, [o3], domain="com.microsoft",
                                          num_heads=heads, name=f"{p}"))
        new_nodes.append(helper.make_node("Reshape", [o3, const([0, 0, heads, d])], [o4], name=o4))
        new_nodes.append(helper.make_node("Transpose", [o4], [n.output[0]], perm=[0, 2, 1, 3],
                                          name=f"{p}_out"))
        n_conv += 1
    del g.node[:]
    g.node.extend(new_nodes)
    # loop: NOT-WORTH — the model's few opsets
    if not any(o.domain == "com.microsoft" for o in model.opset_import):
        model.opset_import.append(helper.make_opsetid("com.microsoft", 1))
    return n_conv, skipped


def cancel_transposes(model):
    """Drop Transpose pairs that undo each other (perm composes to the identity), e.g. the exporter's
    (B,S,h,d)->(B,h,S,d) in front of an attention and convert()'s way back in front of the MHA. Exact (data
    movement only); only pairs whose first Transpose feeds the second alone. Returns the pairs dropped."""
    g = model.graph
    # loop: NOT-WORTH — one pass over the nodes' outputs, offline
    prod = {o: n for n in g.node for o in n.output}
    uses = {}
    # loop: NOT-WORTH — one pass over the nodes' inputs, offline
    for n in g.node:
        # loop: NOT-WORTH — one node's few inputs
        for i in n.input:
            uses[i] = uses.get(i, 0) + 1
    # loop: NOT-WORTH — the graph's few outputs
    outs = {o.name for o in g.output}
    # loop: NOT-WORTH — one node's few attributes
    perm = lambda n: [a.ints for a in n.attribute if a.name == "perm"][0]  # noqa: E731
    rename, drop = {}, set()
    # loop: NOT-WORTH — one pass over the graph's nodes, offline
    for n in g.node:
        t1 = prod.get(n.input[0]) if n.op_type == "Transpose" else None
        if (t1 is None or t1.op_type != "Transpose" or t1.name in drop or uses.get(t1.output[0]) != 1
                or n.output[0] in outs or t1.output[0] in outs):
            continue
        p1, p2 = perm(t1), perm(n)
        # loop: NOT-WORTH — one permutation's ≤ 8 axes
        if len(p1) == len(p2) and all(p1[p2[k]] == k for k in range(len(p2))):
            rename[n.output[0]] = rename.get(t1.input[0], t1.input[0])
            drop.update([t1.name, n.name])
    # loop: NOT-WORTH — one pass over the graph's nodes, offline
    keep = [n for n in g.node if n.name not in drop]
    # loop: NOT-WORTH — one pass over the kept nodes, offline
    for n in keep:
        # loop: NOT-WORTH — one node's few inputs
        for j, i in enumerate(n.input):
            if i in rename:
                n.input[j] = rename[i]
    del g.node[:]
    g.node.extend(keep)
    return len(drop) // 2


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
    # loop: NOT-WORTH — the graph's few inputs
    for i in g.input:
        # loop: NOT-WORTH — one input's few named axes
        for ax, name in DIM_NAMES.get(piece, {}).get(i.name, {}).items():
            d = i.type.tensor_type.shape.dim[ax]
            if re.fullmatch(r"s\d+", d.dim_param or "") and d.dim_param not in ren:
                ren[d.dim_param] = name
    if not ren:
        return ren
    pat = re.compile(r"\b(" + "|".join(sorted(ren, key=len, reverse=True)) + r")\b")
    # loop: NOT-WORTH — one pass over the graph's typed values, offline
    for v in list(g.input) + list(g.output) + list(g.value_info):
        # loop: NOT-WORTH — one value's few dims
        for d in v.type.tensor_type.shape.dim:
            if d.dim_param:
                d.dim_param = pat.sub(lambda mt: ren[mt.group(1)], d.dim_param)
    return ren


def main():
    src, dst = Path(sys.argv[1]), Path(sys.argv[2])
    m = onnx.load(str(src), load_external_data=True)
    n, skipped = convert(m)
    print(f"TO_MHA transpose pairs cancelled: {cancel_transposes(m)}")
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
    # loop: NOT-WORTH — the output file and its .data, removed before saving
    for f in (dst, dst.with_name(dst.name + ".data")):
        if f.exists():
            f.unlink()
    onnx.save(m, str(dst), save_as_external_data=True, all_tensors_to_one_file=True,
              location=dst.name + ".data", size_threshold=1024)
    print(f"TO_MHA {src.name} -> {dst.name}: converted={n} skipped={len(skipped)} {skipped[:5]}")


if __name__ == "__main__":
    main()
