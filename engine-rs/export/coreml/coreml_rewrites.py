"""Exact graph rewrites toward ONNX Runtime 1.31's Core ML EP (ML Program) on a FIXED-shape, folded graph.
usage: coreml_rewrites.py IN.onnx OUT.onnx [--no-rank]   (same folder: shares the .onnx.data file)

1. com.microsoft::MultiHeadAttention -> plain Mul/Transpose/MatMul/Softmax/MatMul (to_trt.py's mha_to_plain,
   the TensorRT set's form; no fp32 islands).
2. RMSNormalization (stash_type=1) -> Cast f32, x*x, ReduceMean(-1), +eps, Sqrt, Div, *w (f32), Cast back.
   Same math, same f32 accumulation as ORT's kernel.
3. Expand with a constant shape -> Reshape (rank align) + Tile (constant repeats). Bit-identical copy.
4. Rank lowering (rank_lower.py): every tensor of rank > 5 is kept as a <= 5-D tensor with the same row-major
   element order; each op that touched one runs on a merged-axis view. Pure index remapping: bit-identical.
"""
import sys
import numpy as np
import onnx
from onnx import helper, numpy_helper, TensorProto

import os
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))  # engine-rs/export: to_trt.py
from to_trt import mha_to_plain, aa_resize_to_matmul  # noqa: E402  (read-only import; the repo is not changed)

sys.path.insert(0, HERE)
import fold  # noqa: E402
from fold import static_shapes, fold_once, prune  # noqa: E402


def uniq(g, base, _c=[0]):
    _c[0] += 1
    return f"cm_{base}_{_c[0]}"


def rms_decompose(m):
    g = m.graph
    inits = {i.name: i for i in g.initializer}
    new, n = [], 0
    for nd in g.node:
        if nd.op_type != "RMSNormalization":
            new.append(nd)
            continue
        a = {x.name: helper.get_attribute_value(x) for x in nd.attribute}
        assert a.get("stash_type", 1) == 1 and a.get("axis", -1) == -1, a
        eps = a.get("epsilon", 1e-5)
        x, w = nd.input[0], nd.input[1]
        w32 = numpy_helper.to_array(inits[w]).astype(np.float32) if w in inits else None
        p = uniq(g, "rms")
        g.initializer.append(numpy_helper.from_array(np.array(eps, np.float32), p + "_eps"))
        g.initializer.append(numpy_helper.from_array(np.array([-1], np.int64), p + "_ax"))
        out_type = TensorProto.FLOAT16  # all RMS norms here are fp16 graphs
        nodes = [
            helper.make_node("Cast", [x], [p + "_x"], to=TensorProto.FLOAT, name=p + "_x"),
            helper.make_node("Mul", [p + "_x", p + "_x"], [p + "_sq"], name=p + "_sq"),
            helper.make_node("ReduceMean", [p + "_sq", p + "_ax"], [p + "_ms"], keepdims=1, name=p + "_ms"),
            helper.make_node("Add", [p + "_ms", p + "_eps"], [p + "_mse"], name=p + "_mse"),
            helper.make_node("Sqrt", [p + "_mse"], [p + "_rms"], name=p + "_rms"),
            helper.make_node("Div", [p + "_x", p + "_rms"], [p + "_n"], name=p + "_n"),
        ]
        if w32 is not None:
            g.initializer.append(numpy_helper.from_array(w32, p + "_w"))
            nodes.append(helper.make_node("Mul", [p + "_n", p + "_w"], [p + "_y"], name=p + "_y"))
        else:
            nodes.append(helper.make_node("Cast", [w], [p + "_wc"], to=TensorProto.FLOAT, name=p + "_wc"))
            nodes.append(helper.make_node("Mul", [p + "_n", p + "_wc"], [p + "_y"], name=p + "_y"))
        nodes.append(helper.make_node("Cast", [p + "_y"], [nd.output[0]], to=out_type, name=p + "_out"))
        new.extend(nodes)
        n += 1
    del g.node[:]
    g.node.extend(new)
    return n


def expand_to_tile(m):
    g = m.graph
    shapes = static_shapes(m)
    consts = {i.name: i for i in g.initializer}
    new, n = [], 0
    for nd in g.node:
        if nd.op_type != "Expand" or nd.input[1] not in consts or nd.input[0] not in shapes:
            new.append(nd)
            continue
        tgt = list(numpy_helper.to_array(consts[nd.input[1]]).astype(np.int64))
        src = list(shapes[nd.input[0]])
        r = max(len(tgt), len(src))
        s = [1] * (r - len(src)) + src
        t = [1] * (r - len(tgt)) + tgt
        out = [max(a, b) if a != 1 else b for a, b in zip(s, t)]
        reps = [o // a for o, a in zip(out, s)]
        p = uniq(g, "exp")
        x = nd.input[0]
        if len(src) != r:
            g.initializer.append(numpy_helper.from_array(np.array(s, np.int64), p + "_shape"))
            new.append(helper.make_node("Reshape", [x, p + "_shape"], [p + "_r"], name=p + "_r"))
            x = p + "_r"
        g.initializer.append(numpy_helper.from_array(np.array(reps, np.int64), p + "_reps"))
        new.append(helper.make_node("Tile", [x, p + "_reps"], [nd.output[0]], name=p + "_t"))
        n += 1
    del g.node[:]
    g.node.extend(new)
    return n


def bias_add_to_sub(m):
    """MatMul -> Add(constant bias) becomes MatMul -> Sub(-bias). Core ML's compiler fuses matmul + add-const into
    `linear`, transposes the weights for it and writes the transposed copy into model.mil as text (C-RADIO: 5 GB of
    text, > 10 GB to load; found on an M6 2026-10-25). It doesn't fuse a Sub, so the weights stay in weight.bin as
    shipped. Exact: negating flips the sign bit. New data: the negated biases only (a few KB each)."""
    g = m.graph
    inits = {i.name: i for i in g.initializer}
    prod = {o: n for n in g.node for o in n.output}
    n = 0
    # loop: NOT-WORTH — one pass over the nodes, once per build
    for node in g.node:
        if node.op_type != "Add":
            continue
        a, b = node.input
        if b in inits and a in prod and prod[a].op_type == "MatMul":
            mm, bias = a, b
        elif a in inits and b in prod and prod[b].op_type == "MatMul":
            mm, bias = b, a
        else:
            continue
        neg = uniq(g, "negbias")
        g.initializer.append(numpy_helper.from_array(-numpy_helper.to_array(inits[bias], fold.BASE), neg))
        node.op_type = "Sub"
        del node.input[:]
        node.input.extend([mm, neg])
        n += 1
    return n


# graph input names Core ML's ML Program parser takes as keywords: the compile on a Mac fails with "Invalid
# operation parameter name: got 'state'" (RVM's recurrent input, found on an M6 2026-10-25; a Linux probe can't see
# it). Renamed to ck_<name>; the engine maps its own name to the file's (runtime.rs Net `renamed`).
RESERVED_INPUTS = {"state"}


def rename_reserved_inputs(m):
    g, n = m.graph, 0
    # loop: NOT-WORTH — ≤ six graph inputs
    for gi in g.input:
        if gi.name in RESERVED_INPUTS:
            old, new = gi.name, "ck_" + gi.name
            gi.name = new
            # loop: NOT-WORTH — one pass over the nodes per renamed input, once per build
            for node in g.node:
                # loop: NOT-WORTH — a node's few inputs
                for i, x in enumerate(node.input):
                    if x == old:
                        node.input[i] = new
            n += 1
    return n


def main():
    src, dst = sys.argv[1], sys.argv[2]
    import fold, os
    fold.BASE = os.path.dirname(os.path.abspath(src))
    m = onnx.load(src, load_external_data=False)
    fp16 = m.graph.input[0].type.tensor_type.elem_type == TensorProto.FLOAT16
    if "cradio" in src:
        fp16 = True  # mixed file: attention under fp16 autocast (to_trt.py's rule)
    n_mha = mha_to_plain(m, fp16)
    n_aa = aa_resize_to_matmul(m, fp16)
    n_rms = rms_decompose(m)
    n_exp = expand_to_tile(m)
    while fold_once(m):
        pass
    n_exp += expand_to_tile(m)  # shapes known only after folding
    n_rank = 0
    if "--no-rank" not in sys.argv:
        from rank_lower import lower
        n_rank = lower(m)
    n_sub = bias_add_to_sub(m)
    prune(m)
    n_ren = rename_reserved_inputs(m)
    onnx.save(m, dst)
    print(f"REWRITE {src} -> {dst}: mha {n_mha}, aa-resize {n_aa}, rms {n_rms}, expand {n_exp}, rank-lowered nodes {n_rank}, "
          f"bias add -> sub {n_sub}, renamed inputs {n_ren}, "
          f"{len(m.graph.node)} nodes")


if __name__ == "__main__":
    main()
