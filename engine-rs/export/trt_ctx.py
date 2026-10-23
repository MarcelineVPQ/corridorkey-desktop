"""Write the EPContext stub ONNX Runtime uses to run a prebuilt TensorRT engine.

usage: python trt_ctx.py SOURCE.onnx OUT_ctx.onnx ENGINE_NAME

The stub has SOURCE's graph inputs and outputs (names, types, dynamic dims, same order) and one
com.microsoft::EPContext node: embed_mode 0, ep_cache_context ENGINE_NAME (a file name, resolved next to the
stub). corridorkey-engine copies the stub into each shape range's cache folder and builds ENGINE_NAME there
with ck-trt-build (strongly typed), then opens the stub with ONNX Runtime's TensorRT provider.
"""
import sys

import onnx
from onnx import helper


def main():
    src, out, engine = sys.argv[1], sys.argv[2], sys.argv[3]
    m = onnx.load(src, load_external_data=False)
    g = m.graph
    node = helper.make_node("EPContext", [i.name for i in g.input], [o.name for o in g.output], name="EPContext",
                            domain="com.microsoft", embed_mode=0, ep_cache_context=engine, main_context=1,
                            source="TensorrtExecutionProvider")
    graph = helper.make_graph([node], g.name or "ck_trt_ctx", list(g.input), list(g.output))
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 23), helper.make_opsetid("com.microsoft", 1)],
                              producer_name="corridorkey trt_ctx.py")
    model.ir_version = m.ir_version
    onnx.save(model, out)
    print(f"TRT_CTX {out}: inputs {[i.name for i in g.input]} outputs {[o.name for o in g.output]} engine {engine}")


if __name__ == "__main__":
    main()
