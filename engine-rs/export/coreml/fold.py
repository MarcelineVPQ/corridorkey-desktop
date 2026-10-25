"""Constant-fold the shape paths of a FIXED-shape ONNX graph (weights untouched, external data shared).
Folds Shape nodes whose input has a static shape and any node whose inputs are all constants with a small
result (<= 65536 elements), evaluated with onnx.reference one node at a time. Exact: the folded values are
what the nodes would compute. usage: fold.py IN.onnx OUT.onnx   (same folder: shares the .onnx.data file)"""
import sys
import numpy as np
import onnx
from onnx import numpy_helper, shape_inference, helper
from onnx.reference import ReferenceEvaluator

BASE = '.'
SMALL = 1 << 22  # elements; folds positional-embedding resizes too


def ort_eval(mm):
    """evaluate a constant node with ONNX Runtime's CPU provider (the same kernels production runs on the CPU)."""
    import onnxruntime as ort
    so = ort.SessionOptions()
    so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_DISABLE_ALL
    so.log_severity_level = 3
    return ort.InferenceSession(mm.SerializeToString(), so, providers=["CPUExecutionProvider"]).run(None, {})


def static_shapes(m):
    mi = shape_inference.infer_shapes(m, data_prop=True)
    out = {}
    for v in list(mi.graph.value_info) + list(mi.graph.input) + list(mi.graph.output):
        t = v.type.tensor_type
        if t.HasField("shape") and all(d.HasField("dim_value") for d in t.shape.dim):
            out[v.name] = [d.dim_value for d in t.shape.dim]
    for i in m.graph.initializer:
        out[i.name] = list(i.dims)
    return out


def fold_once(m):
    g = m.graph
    shapes = static_shapes(m)
    consts = {i.name: i for i in g.initializer if np.prod(i.dims) <= SMALL and i.data_location != onnx.TensorProto.EXTERNAL}
    # external initializers that feed an all-constant, non-weight node (e.g. a positional table resized by a
    # constant size): read them so the node folds; weights of MatMul/Conv/... stay external
    allinit = {i.name: i for i in g.initializer}
    for node in g.node:
        if node.op_type in ("MatMul", "Gemm", "Conv", "ConvTranspose", "LayerNormalization", "RMSNormalization"):
            continue
        if node.input and all(i == "" or i in allinit for i in node.input):
            for i in node.input:
                t = allinit.get(i)
                if t is not None and t.data_location == onnx.TensorProto.EXTERNAL and np.prod(t.dims) <= SMALL:
                    from onnx.external_data_helper import load_external_data_for_tensor
                    import os
                    load_external_data_for_tensor(t, BASE)
                    t.data_location = onnx.TensorProto.DEFAULT
                    del t.external_data[:]
                    consts[i] = t
    opset = [o for o in m.opset_import]
    new_nodes, n = [], 0
    for node in g.node:
        val = None
        if node.op_type == "Shape" and node.input[0] in shapes:
            s = np.array(shapes[node.input[0]], np.int64)
            a = {x.name: helper.get_attribute_value(x) for x in node.attribute}
            st, en = a.get("start", 0), a.get("end", len(s))
            val = [s[st:en]]
        elif node.op_type == "Constant":
            pass
        elif node.domain in ("", "ai.onnx") and node.input and all((i == "" or i in consts) for i in node.input) \
                and node.op_type not in ("RandomNormal", "RandomUniform"):
            try:
                gr = helper.make_graph([node], "f", [], [onnx.ValueInfoProto(name=o) for o in node.output],
                                       [consts[i] for i in node.input if i])
                mm = helper.make_model(gr, opset_imports=opset, ir_version=m.ir_version)
                val = ort_eval(mm)
                if any(np.asarray(v).size > SMALL for v in val):
                    val = None
            except Exception as e:  # leave it to ORT
                if "-v" in sys.argv: print("nofold", node.op_type, str(e)[:150])
                val = None
        if val is None:
            new_nodes.append(node)
            continue
        for o, v in zip(node.output, val):
            t = numpy_helper.from_array(np.asarray(v), o)
            g.initializer.append(t)
            consts[o] = t
        n += 1
    del g.node[:]
    g.node.extend(new_nodes)
    return n


def prune(m):
    g = m.graph
    used = {i for nd in g.node for i in nd.input} | {o.name for o in g.output}
    alive = []
    # drop nodes whose outputs are unused (walk backwards)
    changed = True
    nodes = list(g.node)
    while changed:
        changed = False
        used = {i for nd in nodes for i in nd.input} | {o.name for o in g.output}
        keep = [nd for nd in nodes if any(o in used for o in nd.output)]
        if len(keep) != len(nodes):
            nodes, changed = keep, True
    del g.node[:]
    g.node.extend(nodes)
    used = {i for nd in g.node for i in nd.input}
    keep = [i for i in g.initializer if i.name in used]
    del g.initializer[:]
    g.initializer.extend(keep)


def main():
    global BASE
    src, dst = sys.argv[1], sys.argv[2]
    import os
    BASE = os.path.dirname(os.path.abspath(src))
    m = onnx.load(src, load_external_data=False)
    total = 0
    while True:
        k = fold_once(m)
        total += k
        if not k:
            break
    prune(m)
    onnx.save(m, dst)
    print(f"FOLD {src} -> {dst}: folded {total} nodes, {len(m.graph.node)} left")


if __name__ == "__main__":
    main()
