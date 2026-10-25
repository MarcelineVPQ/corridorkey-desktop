"""Fold autocast's weight casts into float16 initializers (exact; set 2.0.0-onnx.4 on).

usage: python fold_casts.py IN.onnx OUT.onnx

A graph traced under autocast (export.py --amp) keeps fp32 weights and casts them to fp16 in front of each
conv / matmul: Cast(W), or Cast(Reshape(Concat(Unsqueeze(W_i)))) for DepthwiseSwiGLU2D's grouped weights.
ORT would fold those casts at load, but the file carries every weight twice the size, and speed_patches.py's
rewrites look for the weight initializer itself on the ConvTranspose / grouped Conv. Each such Cast to
float16 whose input is computed from initializers through data-movement ops only (Reshape, Unsqueeze,
Squeeze, Concat, Transpose, Identity) is replaced by the same chain on float16 copies of its initializers.
Data movement commutes with an elementwise cast and numpy rounds float32 -> float16 to nearest even like
ORT's Cast, so the values are bit-identical to what the original graph computes. fp32 initializers still used
elsewhere (the fp32 islands) stay.
"""
import sys
from pathlib import Path

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

MOVE = {"Reshape", "Unsqueeze", "Squeeze", "Concat", "Transpose", "Identity"}


def fold(m):
    g = m.graph
    inits = {i.name: i for i in g.initializer}
    prod = {o: n for n in g.node for o in n.output}
    f16_of, cloned, n_direct, n_chain = {}, {}, 0, 0
    new_nodes_before = {}  # cast node name -> nodes to insert in its place

    def is_const_chain(name, depth=0):
        if name in inits:
            return True
        n = prod.get(name)
        if n is None or n.op_type not in MOVE or depth > 8:
            return False
        # the first input carries data; shape / axes inputs must be integer initializers or Constants
        data = n.input if n.op_type == "Concat" else n.input[:1]
        rest = [] if n.op_type == "Concat" else [i for i in n.input[1:] if i]
        ok_rest = all(i in inits and inits[i].data_type == TensorProto.INT64
                      or (prod.get(i) is not None and prod[i].op_type == "Constant") for i in rest)
        return ok_rest and all(is_const_chain(d, depth + 1) for d in data)

    def f16_init(name):
        if name not in f16_of:
            t = inits[name]
            if t.data_type == TensorProto.FLOAT16:
                f16_of[name] = name
            else:
                assert t.data_type == TensorProto.FLOAT, (name, t.data_type)
                arr = numpy_helper.to_array(t).astype(np.float16)
                nn = name + "_f16"
                g.initializer.append(numpy_helper.from_array(arr, nn))
                f16_of[name] = nn
        return f16_of[name]

    def clone(name, out_nodes):
        """name of the float16 version of constant chain value `name`"""
        if name in inits:
            return f16_init(name)
        if name in cloned:
            return cloned[name]
        n = prod[name]
        ins = list(n.input)
        data_idx = range(len(ins)) if n.op_type == "Concat" else [0]
        for k in data_idx:
            ins[k] = clone(ins[k], out_nodes)
        out = name + "_f16"
        c = helper.make_node(n.op_type, ins, [out], name=(n.name or out) + "_f16")
        c.attribute.extend(n.attribute)
        out_nodes.append(c)
        cloned[name] = out
        return out

    rename = {}
    keep = []
    for n in g.node:
        to = [a.i for a in n.attribute if a.name == "to"] if n.op_type == "Cast" else []
        if to == [TensorProto.FLOAT16] and is_const_chain(n.input[0]):
            extra = []
            src = clone(n.input[0], extra)
            keep.extend(extra)
            rename[n.output[0]] = src
            if n.input[0] in inits:
                n_direct += 1
            else:
                n_chain += 1
            continue
        keep.append(n)
    for n in keep:
        for k, i in enumerate(n.input):
            if i in rename:
                n.input[k] = rename[i]
    for o in g.output:
        assert o.name not in rename, f"graph output {o.name} is a folded cast"
    del g.node[:]
    g.node.extend(keep)
    # drop what nothing reads any more (the fp32 originals of folded weights, their now-unused chains)
    while True:
        used = {i for n in g.node for i in n.input} | {o.name for o in g.output}
        dead = [n for n in g.node if not any(o in used for o in n.output)]
        if not dead:
            break
        for d in dead:
            g.node.remove(d)
    used = {i for n in g.node for i in n.input}
    live = [i for i in g.initializer if i.name in used]
    n_dropped = len(g.initializer) - len(live)
    del g.initializer[:]
    g.initializer.extend(live)
    return n_direct, n_chain, n_dropped


def main():
    src, dst = Path(sys.argv[1]), Path(sys.argv[2])
    m = onnx.load(str(src), load_external_data=True)
    n_direct, n_chain, n_dropped = fold(m)
    onnx.checker.check_model(m, full_check=False)
    for f in (dst, dst.with_name(dst.name + ".data")):
        if f.exists():
            f.unlink()
    onnx.save(m, str(dst), save_as_external_data=True, all_tensors_to_one_file=True,
              location=dst.name + ".data", size_threshold=1024)
    print(f"FOLD_CASTS {src.name} -> {dst.name}: weight casts {n_direct}, cast chains {n_chain}, "
          f"fp32 initializers dropped {n_dropped}")


if __name__ == "__main__":
    main()
