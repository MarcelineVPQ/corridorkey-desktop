"""Make a production ONNX file (2.0.0-onnx.1) parseable by TensorRT 10.16's ONNX parser.

usage: python to_trt.py IN.onnx OUT.onnx

The production set is built for ONNX Runtime's CUDA provider. TensorRT's parser rejects two things in it:

1. `com.microsoft::MultiHeadAttention` (to_mha.py's rewrite of every attention): no TensorRT plugin
   ("Plugin not found"). Each MHA, with the Transpose/Reshape pairs to_mha.py put around it, goes back to
   the original 4D form as plain ops:
       Q (B,h,S,d) * 1/sqrt(d) -> MatMul(K^T) -> Softmax(-1) -> MatMul(V) -> out (B,h,S,d)
   This is the pattern TensorRT fuses into its own attention kernels. (The opset-23 `Attention` op needs a
   strongly typed network in TensorRT 10.16, which ORT's TensorRT provider doesn't make.) The scale goes on
   Q before the product, as MHA does.
2. MoGe's antialiased bilinear `Resize` (`antialias=1`, torch's `_upsample_bilinear2d_aa`): the parser
   can't take it. It becomes two in-graph weight matrices built from the input/output sizes, so it stays
   dynamic: W[o, j] = max(0, 1 - |j + 0.5 - s*(o + 0.5)| / max(s, 1)), s = in/out, rows normalised
   (torch's aa kernel: triangle filter with support max(s, 1), weights normalised over the taps; the taps it
   keeps are exactly the ones where the triangle is non-zero). y = W_h @ x @ W_w^T, in float32.

Everything else is kept node for node, so the weights and the rest of the graph stay identical.
"""
import sys
from pathlib import Path

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper


def _init(g, name, arr):
    g.initializer.append(numpy_helper.from_array(arr, name))
    return name


def mha_to_plain(model, fp16):
    g = model.graph
    # loop: NOT-WORTH — one pass over the nodes' outputs, offline
    prod = {o: n for n in g.node for o in n.output}
    cons = {}
    # loop: NOT-WORTH — one pass over the graph's nodes, offline (an export step)
    for n in g.node:
        # loop: NOT-WORTH — one node's few inputs
        for i in n.input:
            cons.setdefault(i, []).append(n)
    # loop: NOT-WORTH — one pass over the initializers, offline
    inits = {i.name: i for i in g.initializer}
    drop, add, count = set(), {}, 0
    types = elem_types(model)
    # loop: NOT-WORTH — one pass over the graph's nodes, offline (an export step)
    for n in g.node:
        if not (n.op_type == "MultiHeadAttention" and n.domain == "com.microsoft"):
            continue
        # loop: NOT-WORTH — one node's few attributes
        heads = [a.i for a in n.attribute if a.name == "num_heads"][0]
        src = []
        # loop: NOT-WORTH — one MultiHeadAttention node's q, k, v
        for r in n.input[:3]:
            rn = prod[r]
            tn = prod[rn.input[0]]
            assert rn.op_type == "Reshape" and tn.op_type == "Transpose", n.name
            src.append(tn.input[0])
            drop.update([rn.name, tn.name])
        (o3,) = n.output
        (ro,) = cons[o3]
        (to,) = cons[ro.output[0]]
        assert ro.op_type == "Reshape" and to.op_type == "Transpose", n.name
        shape = numpy_helper.to_array(inits[ro.input[1]])
        assert shape[2] == heads, (n.name, shape)
        d = int(shape[3])
        drop.update([n.name, ro.name, to.name])
        p = f"{n.name}_plain"
        q, k, v = src
        # the scale in Q's type (mixed files: attention runs in fp16 whatever the file's input type)
        dt = np.float16 if types.get(q, TensorProto.FLOAT16 if fp16 else TensorProto.FLOAT) == TensorProto.FLOAT16 else np.float32
        scale = _init(g, f"{p}_scale", np.array(1.0 / np.sqrt(d), dtype=dt))
        nodes = [
            helper.make_node("Mul", [q, scale], [f"{p}_qs"], name=f"{p}_qs"),
            helper.make_node("Transpose", [k], [f"{p}_kt"], perm=[0, 1, 3, 2], name=f"{p}_kt"),
            helper.make_node("MatMul", [f"{p}_qs", f"{p}_kt"], [f"{p}_s"], name=f"{p}_s"),
            helper.make_node("Softmax", [f"{p}_s"], [f"{p}_p"], axis=-1, name=f"{p}_p"),
            helper.make_node("MatMul", [f"{p}_p", v], [to.output[0]], name=f"{p}_o"),
        ]
        add[n.name] = nodes
        count += 1
    new = []
    # loop: NOT-WORTH — one pass over the graph's nodes, offline (an export step)
    for n in g.node:
        if n.name in add:
            new.extend(add[n.name])
        elif n.name not in drop:
            new.append(n)
    del g.node[:]
    g.node.extend(new)
    # loop: NOT-WORTH — one pass over the nodes' inputs, offline
    used = {i for n in g.node for i in n.input}
    # loop: NOT-WORTH — one pass over the initializers, offline
    keep = [i for i in g.initializer if i.name in used or not i.name.startswith("mha_shape_")]
    del g.initializer[:]
    g.initializer.extend(keep)
    # loop: NOT-WORTH — one pass over the graph's nodes, offline (an export step)
    if not any(n.domain == "com.microsoft" for n in g.node):
        # loop: NOT-WORTH — the model's few opsets
        ops = [o for o in model.opset_import if o.domain != "com.microsoft"]
        del model.opset_import[:]
        model.opset_import.extend(ops)
    return count


def aa_resize_to_matmul(model, fp16):
    g = model.graph
    types = elem_types(model)
    file_fp16 = fp16
    count = 0
    new = []
    c = lambda name, arr: _init(g, name, arr)
    # loop: NOT-WORTH — one pass over the graph's nodes, offline (an export step)
    for n in g.node:
        # loop: NOT-WORTH — one node's few attributes
        attrs = {a.name: helper.get_attribute_value(a) for a in n.attribute}
        if not (n.op_type == "Resize" and attrs.get("antialias", 0) == 1 and attrs.get("mode") == b"linear"
                and attrs.get("coordinate_transformation_mode") == b"half_pixel"):
            new.append(n)
            continue
        x, sizes = n.input[0], n.input[3]
        # in x's type (mixed files: the original's policy runs this resize in fp32)
        fp16 = types.get(x, TensorProto.FLOAT16 if file_fp16 else TensorProto.FLOAT) == TensorProto.FLOAT16
        assert sizes, "aa Resize with scales is not handled"
        p = f"{n.name}_mm"
        f32 = TensorProto.FLOAT
        c(f"{p}_i2", np.array(2, np.int64))
        c(f"{p}_i3", np.array(3, np.int64))
        c(f"{p}_z", np.array(0, np.int64))
        c(f"{p}_one", np.array(1, np.int64))
        c(f"{p}_h", np.array(0.5, np.float32))
        c(f"{p}_1f", np.array(1.0, np.float32))
        c(f"{p}_ax0", np.array([0], np.int64))
        c(f"{p}_ax1", np.array([1], np.int64))
        nodes = [helper.make_node("Shape", [x], [f"{p}_shp"], name=f"{p}_shp")]

        def weights(tag, axis):
            q = f"{p}_{tag}"
            idx = f"{p}_i{axis}"
            return [
                helper.make_node("Gather", [f"{p}_shp", idx], [f"{q}_in"], axis=0, name=f"{q}_in"),
                helper.make_node("Gather", [sizes, idx], [f"{q}_out"], axis=0, name=f"{q}_out"),
                helper.make_node("Cast", [f"{q}_in"], [f"{q}_inf"], to=f32, name=f"{q}_inf"),
                helper.make_node("Cast", [f"{q}_out"], [f"{q}_outf"], to=f32, name=f"{q}_outf"),
                helper.make_node("Div", [f"{q}_inf", f"{q}_outf"], [f"{q}_s"], name=f"{q}_s"),
                helper.make_node("Max", [f"{q}_s", f"{p}_1f"], [f"{q}_sup"], name=f"{q}_sup"),
                helper.make_node("Range", [f"{p}_z", f"{q}_out", f"{p}_one"], [f"{q}_o"], name=f"{q}_o"),
                helper.make_node("Range", [f"{p}_z", f"{q}_in", f"{p}_one"], [f"{q}_j"], name=f"{q}_j"),
                helper.make_node("Cast", [f"{q}_o"], [f"{q}_of"], to=f32, name=f"{q}_of"),
                helper.make_node("Cast", [f"{q}_j"], [f"{q}_jf"], to=f32, name=f"{q}_jf"),
                helper.make_node("Add", [f"{q}_of", f"{p}_h"], [f"{q}_oh"], name=f"{q}_oh"),
                helper.make_node("Mul", [f"{q}_oh", f"{q}_s"], [f"{q}_c"], name=f"{q}_c"),
                helper.make_node("Unsqueeze", [f"{q}_c", f"{p}_ax1"], [f"{q}_c2"], name=f"{q}_c2"),
                helper.make_node("Add", [f"{q}_jf", f"{p}_h"], [f"{q}_jh"], name=f"{q}_jh"),
                helper.make_node("Unsqueeze", [f"{q}_jh", f"{p}_ax0"], [f"{q}_j2"], name=f"{q}_j2"),
                helper.make_node("Sub", [f"{q}_j2", f"{q}_c2"], [f"{q}_d"], name=f"{q}_d"),
                helper.make_node("Abs", [f"{q}_d"], [f"{q}_ad"], name=f"{q}_ad"),
                helper.make_node("Div", [f"{q}_ad", f"{q}_sup"], [f"{q}_x"], name=f"{q}_x"),
                helper.make_node("Sub", [f"{p}_1f", f"{q}_x"], [f"{q}_t"], name=f"{q}_t"),
                helper.make_node("Relu", [f"{q}_t"], [f"{q}_w"], name=f"{q}_w"),
                helper.make_node("ReduceSum", [f"{q}_w", f"{p}_ax1"], [f"{q}_ws"], keepdims=1, name=f"{q}_ws"),
                helper.make_node("Div", [f"{q}_w", f"{q}_ws"], [f"{q}_W"], name=f"{q}_W"),
            ]

        nodes += weights("h", 2) + weights("w", 3)
        xin = x
        if fp16:
            nodes.append(helper.make_node("Cast", [x], [f"{p}_x32"], to=f32, name=f"{p}_x32"))
            xin = f"{p}_x32"
        out = n.output[0]
        y32 = f"{p}_y32" if fp16 else out
        nodes += [
            helper.make_node("MatMul", [f"{p}_h_W", xin], [f"{p}_hx"], name=f"{p}_hx"),
            helper.make_node("Transpose", [f"{p}_w_W"], [f"{p}_wT"], perm=[1, 0], name=f"{p}_wT"),
            helper.make_node("MatMul", [f"{p}_hx", f"{p}_wT"], [y32], name=f"{p}_y"),
        ]
        if fp16:
            nodes.append(helper.make_node("Cast", [y32], [out], to=TensorProto.FLOAT16, name=f"{p}_y16"))
        new.extend(nodes)
        count += 1
    del g.node[:]
    g.node.extend(new)
    return count


def elem_types(model):
    """Each tensor's element type (name -> TensorProto type), by ONNX shape inference on the graph's structure.

    Mixed-precision files (2.0.0-onnx.4 on: the original's autocast policy) run some ops in fp16 and others in fp32,
    so a file's input type no longer says what an op computes in. Large initializers become typed graph inputs for
    the inference (their values aren't needed for types; this keeps the proto far under protobuf's 2 GB).
    """
    g = model.graph
    # loop: NOT-WORTH — one pass over the initializers
    small = [i for i in g.initializer if np.prod(i.dims, dtype=np.int64) <= 4096]
    # loop: NOT-WORTH — one pass over the initializers (the weights' bytes are never copied)
    typed = [helper.make_tensor_value_info(i.name, i.data_type, list(i.dims))
             for i in g.initializer if np.prod(i.dims, dtype=np.int64) > 4096]
    sg = helper.make_graph(list(g.node), g.name, list(g.input) + typed, list(g.output), initializer=small,
                           value_info=list(g.value_info))
    m = helper.make_model(sg, opset_imports=list(model.opset_import), ir_version=model.ir_version)
    m.functions.extend(model.functions)
    m = onnx.shape_inference.infer_shapes(m, strict_mode=False)
    t = {}
    # loop: NOT-WORTH — one pass over the graph's typed values
    for v in list(m.graph.value_info) + list(m.graph.input) + list(m.graph.output):
        if v.type.tensor_type.elem_type:
            t[v.name] = v.type.tensor_type.elem_type
    # loop: NOT-WORTH — one pass over the initializers
    for i in model.graph.initializer:
        t[i.name] = i.data_type
    return t


def fp32_islands(model, ops, weights_only=False, default_fp16=True):
    """fp16 graphs: run the listed op types in float32 (Cast in, float32 weights, Cast out).

    TensorRT's fp16 kernels for these ops lose more precision than ONNX Runtime's CUDA fp16 kernels (measured
    per layer type on stage 2: ConvTranspose, Conv and MatMul; docs/ONNX_EXPORT.md "TensorRT"). With
    weights_only, only MatMuls with a constant (weight) operand are moved (the linear layers, not attention).
    Only ops that compute in fp16 are moved (their output's type; mixed files keep fp32 ops as they are); an op whose
    type inference can't tell follows default_fp16 (the file's input type, as before mixed files).
    """
    types = elem_types(model)
    g = model.graph
    # loop: NOT-WORTH — one pass over the initializers, offline
    inits = {i.name: i for i in g.initializer}
    # loop: NOT-WORTH — one pass over the graph's nodes, offline (an export step)
    consts = {n.output[0] for n in g.node if n.op_type == "Constant"}
    # C-RADIO's fp16 file keeps fp32 weights and casts / transposes them (autocast): those are weights too
    # loop: NOT-WORTH — one pass over the nodes (topologically sorted)
    for n in g.node:
        if n.op_type in ("Cast", "Transpose") and (n.input[0] in inits or n.input[0] in consts):
            consts.add(n.output[0])
    converted, new, count = {}, [], 0
    F16, F32 = TensorProto.FLOAT16, TensorProto.FLOAT

    def to32(name, tag):
        if name in inits and inits[name].data_type == F16:
            if name not in converted:
                arr = numpy_helper.to_array(inits[name]).astype(np.float32)
                converted[name] = _init(g, f"{name}_f32", arr)
            return converted[name], []
        c = f"{tag}_{len(new)}_c32"
        return c, [helper.make_node("Cast", [name], [c], to=F32, name=c)]

    # loop: NOT-WORTH — one pass over the graph's nodes, offline (an export step)
    for n in g.node:
        if n.op_type not in ops or types.get(n.output[0], F16 if default_fp16 else F32) != F16:
            new.append(n)
            continue
        # loop: NOT-WORTH — one MatMul's two inputs
        if weights_only and n.op_type == "MatMul" and not any(i in inits or i in consts for i in n.input):
            new.append(n)
            continue
        ins = []
        # loop: NOT-WORTH — one node's few inputs
        for j, x in enumerate(n.input):
            if not x:
                ins.append(x)
                continue
            c, pre = to32(x, f"{n.name}_i{j}")
            new.extend(pre)
            ins.append(c)
        out = n.output[0]
        o32 = f"{n.name}_o32"
        n2 = helper.make_node(n.op_type, ins, [o32], name=n.name + "_f32", domain=n.domain)
        n2.attribute.extend(n.attribute)
        new.append(n2)
        new.append(helper.make_node("Cast", [o32], [out], to=F16, name=f"{n.name}_o16"))
        count += 1
    del g.node[:]
    g.node.extend(new)
    # loop: NOT-WORTH — one pass over the nodes' inputs, offline
    used = {i for n in g.node for i in n.input}
    # loop: NOT-WORTH — one pass over the initializers, offline
    keep = [i for i in g.initializer if i.name in used]
    del g.initializer[:]
    g.initializer.extend(keep)
    return count


def main():
    src, dst = Path(sys.argv[1]), Path(sys.argv[2])
    # loop: NOT-WORTH — the few command-line arguments
    islands = next((a.split("=", 1)[1] for a in sys.argv[3:] if a.startswith("--fp32-ops=")), "")
    weights_only = "--weights-only" in sys.argv
    m = onnx.load(str(src), load_external_data=True)
    fp16 = m.graph.input[0].type.tensor_type.elem_type == TensorProto.FLOAT16
    if "cradio" in src.name:  # mixed: fp32 I/O, attention under fp16 autocast
        fp16 = "fp16" in src.name
    n_mha = mha_to_plain(m, fp16)
    n_rs = aa_resize_to_matmul(m, fp16)
    # mixed files (fp32 input, fp16 inside) get islands too: only their fp16 ops move
    n_isl = fp32_islands(m, set(islands.split(",")), weights_only, default_fp16=fp16) if islands else 0
    # loop: NOT-WORTH — the output file and its .data, removed before saving
    for f in (dst, dst.with_name(dst.name + ".data")):
        if f.exists():
            f.unlink()
    onnx.save(m, str(dst), save_as_external_data=True, all_tensors_to_one_file=True,
              location=dst.name + ".data", size_threshold=1024)
    onnx.checker.check_model(str(dst))
    print(f"TO_TRT {src.name} -> {dst.name}: attention {n_mha}, aa resize {n_rs}, fp16 attention {fp16}, fp32 islands {n_isl} ({islands or '-'}{', weights only' if weights_only else ''})")


if __name__ == "__main__":
    main()
