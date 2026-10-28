"""The MIGraphX set: the TensorRT-ready exports with RMSNormalization written as SimplifiedLayerNormalization.

usage: python -I migraphx_patch.py MODELS_DIR [SOURCE]

SOURCE: the models.json entry to start from, default "tensorrt-fp16": MIGraphX 2.18's ONNX parser (ROCm 10.1) refuses
the plain MoGe file (its antialiased resize: Resize exclude_outside=1), and the TensorRT-ready export has that resize
as weight matrices (docs/AMD.md, tools/migraphx_ops.py). Its stage 1 and stage 2 use RMSNormalization (opset 23), an
op MIGraphX doesn't know; SimplifiedLayerNormalization (ORT's contrib op in the ONNX domain, which MIGraphX parses) is
the same function: x / sqrt(mean(x^2 over axis) + epsilon) * scale. A float32 norm becomes that op with the same
inputs, axis and epsilon. A float16 norm (stash_type 1: ORT computes it in float32) is computed in float32 here too:
Cast(x), Cast(scale) -> the op -> Cast back to float16, because MIGraphX's SimplifiedLayerNormalization would
otherwise add epsilon and take the reciprocal root in float16. Measured on ORT's CPU provider (256x256): stage 2
bit-identical, stage 1 within one float16 step.

Writes <stem>-migraphx.onnx next to each file it changes (its initializers keep pointing at the source's .onnx.data,
so no weights are copied) and the "migraphx-fp16" entry of models.json (unchanged files listed as they are). The
engine's MIGraphX provider loads that entry's files (runtime.rs ModelSet::migraphx_file).
"""
import json
import sys
from pathlib import Path

import onnx
from onnx import TensorProto, helper


def keep(n):
    """axis and epsilon; not stash_type (SimplifiedLayerNormalization's default is float32 too, and MIGraphX warns
    about it on every node)."""
    # loop: NOT-WORTH — a node's three attributes
    return [a for a in n.attribute if a.name != "stash_type"]


def patch(m: onnx.ModelProto) -> int:
    g = m.graph
    m2 = onnx.shape_inference.infer_shapes(m)
    # loop: NOT-WORTH — the graph's value infos, once per network, offline
    types = {v.name: v.type.tensor_type.elem_type for v in list(m2.graph.input) + list(m2.graph.value_info)}
    # loop: NOT-WORTH — the initializers, once per network, offline
    types.update({i.name: i.data_type for i in g.initializer})
    out, n_done = [], 0
    # loop: NOT-WORTH — one pass over the nodes, offline
    for n in g.node:
        if n.op_type != "RMSNormalization":
            out.append(n)
            continue
        if len(n.input) != 2:
            raise SystemExit(f"{n.name}: RMSNormalization with {len(n.input)} inputs (expected x, scale)")
        x, scale = n.input
        tx = types.get(x)
        if tx == TensorProto.FLOAT:
            out.append(helper.make_node("SimplifiedLayerNormalization", [x, scale], list(n.output), name=n.name, domain=""))
            out[-1].attribute.extend(keep(n))
        elif tx == TensorProto.FLOAT16:
            p = n.name or n.output[0]
            out += [
                helper.make_node("Cast", [x], [f"{p}_x32"], name=f"{p}_cast_x", to=TensorProto.FLOAT),
                helper.make_node("Cast", [scale], [f"{p}_s32"], name=f"{p}_cast_s", to=TensorProto.FLOAT),
            ]
            sln = helper.make_node("SimplifiedLayerNormalization", [f"{p}_x32", f"{p}_s32"], [f"{p}_y32"], name=n.name, domain="")
            sln.attribute.extend(keep(n))
            out += [sln, helper.make_node("Cast", [f"{p}_y32"], list(n.output), name=f"{p}_cast_y", to=TensorProto.FLOAT16)]
        else:
            raise SystemExit(f"{n.name}: RMSNormalization input type {tx} (expected float or float16)")
        n_done += 1
    del g.node[:]
    g.node.extend(out)
    return n_done


def main():
    d = Path(sys.argv[1])
    source = sys.argv[2] if len(sys.argv) > 2 else "tensorrt-fp16"
    mpath = d / "models.json"
    models = json.loads(mpath.read_text())
    entry = {}
    # loop: NOT-WORTH — five networks
    for piece, name in models[source].items():
        src = d / name
        m = onnx.load(str(src), load_external_data=False)
        n = patch(m)
        if not n:
            entry[piece] = name
            continue
        dst = src.with_name(src.stem + "-migraphx.onnx")
        onnx.save(m, str(dst))
        entry[piece] = dst.name
        print(f"{piece}: {n} RMSNormalization -> SimplifiedLayerNormalization, {dst.name}")
    models["migraphx-fp16"] = entry
    mpath.write_text(json.dumps(models, indent=2) + "\n")


if __name__ == "__main__":
    main()
