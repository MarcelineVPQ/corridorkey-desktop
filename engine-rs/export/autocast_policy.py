"""Export a piece under fp16 autocast with the original's (CUDA autocast) precision policy.

The original runs every network under torch.autocast("cuda", bfloat16): fp32 weights, low precision only for
CUDA autocast's lower-precision list (conv, matmul, linear, attention, ...); its fp32 list (norms, softmax,
exp/log/pow, reductions, upsampling, ...) runs in fp32, everything else in its inputs' type, so a residual
stream that starts in fp32 stays fp32. Exports trace on the CPU, and CPU autocast casts the same heavy ops to
fp16 but has no such fp32 list: a layer_norm / softmax / exp fed by an fp16 conv output would stay fp16.
`cuda_fp32_policy()` registers AutocastCPU kernels for CUDA's fp32 lists (torch 2.9.1
aten/src/ATen/autocast_mode.h: AT_FORALL_FP32, AT_FORALL_FP32_SET_OPT_DTYPE, norm), which cast fp16 inputs
to fp32 and run the op in fp32, so the traced graph follows the original's split.
"""
import torch

# AT_FORALL_FP32 (torch 2.9.1), the ops this model family can reach; losses are left out (not in inference)
CUDA_FP32 = [
    "acos", "asin", "cosh", "erfinv", "exp", "expm1", "log", "log10", "log2", "log1p", "reciprocal", "rsqrt",
    "sinh", "tan", "pow.Tensor_Scalar", "pow.Tensor_Tensor", "pow.Scalar", "softplus", "layer_norm",
    "native_layer_norm", "group_norm", "frobenius_norm.dim", "nuclear_norm", "nuclear_norm.dim",
    "cosine_similarity", "dist", "pdist", "cdist", "renorm", "logsumexp",
    "upsample_nearest1d", "_upsample_nearest_exact1d", "upsample_nearest2d", "_upsample_nearest_exact2d",
    "upsample_nearest3d", "_upsample_nearest_exact3d", "upsample_linear1d", "upsample_bilinear2d",
    "_upsample_bilinear2d_aa", "upsample_trilinear3d", "upsample_bicubic2d", "_upsample_bicubic2d_aa",
    "upsample_nearest1d.vec", "upsample_nearest2d.vec", "upsample_nearest3d.vec", "_upsample_nearest_exact1d.vec",
    "_upsample_nearest_exact2d.vec", "_upsample_nearest_exact3d.vec", "upsample_linear1d.vec",
    "upsample_bilinear2d.vec", "_upsample_bilinear2d_aa.vec", "upsample_trilinear3d.vec", "upsample_bicubic2d.vec",
    "_upsample_bicubic2d_aa.vec",
    # AT_FORALL_FP32_SET_OPT_DTYPE (output in fp32)
    "prod", "prod.dim_int", "softmax.int", "log_softmax.int", "cumprod", "cumsum", "linalg_vector_norm",
    "linalg_matrix_norm", "linalg_matrix_norm.str_ord", "sum", "sum.dim_IntList",
    # AT_FORALL_DIFFERENT_REDISPATCH_SIGNATURE
    "norm.Scalar", "norm.ScalarOpt_dim",
]

# graph inputs the original feeds as bfloat16 (exported as float16, which holds those values exactly in their
# range) and that are large (full-resolution windows). The rest are float32: features, RVM frame and state as the
# original feeds them; MoGe's small input (bfloat16 in the original) as float32, which holds it exactly.
LOW_INPUTS = {"stage1": ("rgb", "hint", "hint_quality"), "stage2": ("rgb",)}

_lib = None
_AC = torch._C.DispatchKeySet(torch._C.DispatchKey.AutocastCPU)


def _up(a):
    if isinstance(a, torch.Tensor) and a.dtype in (torch.float16, torch.bfloat16):
        return a.float()
    if isinstance(a, (list, tuple)):
        return type(a)(_up(x) for x in a)
    return a


def _kernel(op):
    def k(*args, **kwargs):
        with torch._C._ExcludeDispatchKeyGuard(_AC):
            return op(*_up(args), **{n: _up(v) for n, v in kwargs.items()})
    return k


def cuda_fp32_policy():
    """Register the AutocastCPU fp32 kernels once (process-wide). Returns the ops registered."""
    global _lib
    if _lib is not None:
        return
    _lib = torch.library.Library("aten", "IMPL")
    done = []
    for name in CUDA_FP32:
        base, _, ov = name.partition(".")
        packet = getattr(torch.ops.aten, base, None)
        if packet is None:
            continue
        op = getattr(packet, ov or "default", None)
        if op is None:
            continue
        _lib.impl(name, _kernel(op), "AutocastCPU")
        done.append(name)
    return done


def autocast_piece(inner, input_names, cuda_fp32=True):
    """`inner` run under CPU fp16 autocast (fp32 weights), with the original's fp32 list when `cuda_fp32`.

    forward takes the named inputs explicitly: torch 2.9's export fails to decompose an autocast region entered
    from a `*args` forward (NameError: name 'L' is not defined)."""
    if cuda_fp32:
        cuda_fp32_policy()
    names = ", ".join(input_names)
    src = (f"def forward(self, {names}):\n"
           f"    with torch.autocast('cpu', dtype=torch.float16):\n"
           f"        return self.inner({names})\n")
    ns = {"torch": torch}
    exec(src, ns)
    cls = type("AutocastPiece", (torch.nn.Module,), {"forward": ns["forward"]})
    mod = cls()
    mod.inner = inner
    return mod
