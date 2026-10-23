"""Export-friendly nn.Module wrappers around the CorridorKey v2 pieces.

Each wrapper takes plain tensors and returns plain tensors so the ONNX graph
has a fixed, documented I/O contract that an ORT engine process can call.
"""
import torch
import torch.nn as nn


class CradioPiece(nn.Module):
    """(N, 3, H/4, W/4) RGB [0,1] -> (N, C, H/64, W/64) normalized features."""

    def __init__(self, foundations):
        super().__init__()
        self.cradio = foundations.cradio
        self.register_buffer("mean", foundations.cradio_mean.detach().clone().view(1, -1, 1, 1))
        self.register_buffer("std", foundations.cradio_std.detach().clone().clamp(min=1e-6).view(1, -1, 1, 1))

    def forward(self, rgb):
        # Same call path as FrozenFoundations.forward (RADIOModel has no
        # feature_fmt kwarg in this snapshot, so it falls back to (N, L, C)).
        feat = self.cradio(rgb).features
        if feat.dim() == 3:
            n, _, c = feat.shape
            h, w = rgb.shape[-2] // 16, rgb.shape[-1] // 16
            feat = feat.transpose(1, 2).reshape(n, c, h, w)
        return (feat.float() - self.mean) / self.std


class MogePiece(nn.Module):
    """(N, 3, 7H/32, 7W/32) RGB [0,1] -> (N, 768, H/64, W/64) normalized."""

    def __init__(self, foundations):
        super().__init__()
        self.moge = foundations.moge
        self.register_buffer("mean", foundations.moge_mean.detach().clone().view(1, -1, 1, 1))
        self.register_buffer("std", foundations.moge_std.detach().clone().clamp(min=1e-6).view(1, -1, 1, 1))

    def forward(self, rgb):
        Hm, Wm = rgb.shape[-2], rgb.shape[-1]
        feat, _ = self.moge.encoder(rgb, Hm // 14, Wm // 14, return_class_token=True)
        return (feat.float() - self.mean) / self.std


class RvmStepPiece(nn.Module):
    """One recurrent RVM step.

    frames: (N, 3, H/4, W/4) in [0,1] -- N consecutive frames; the encoder is
    batched, the GRU core runs sequentially over N inside the graph is NOT
    possible without Loop, so N must be 1 here (the host loops over frames).
    state:  (1, 1 + h*w, 384)
    returns feat (1, 384, h, w) normalized, new_state.
    """

    def __init__(self, foundations):
        super().__init__()
        self.rvm = foundations.rvm
        self.register_buffer("mean", foundations.rvm_mean.detach().clone().view(1, -1, 1, 1))
        self.register_buffer("std", foundations.rvm_std.detach().clone().clamp(min=1e-6).view(1, -1, 1, 1))

    def forward(self, frame, state):
        rvm = self.rvm
        H, W = frame.shape[-2], frame.shape[-1]
        h, w = H // 16, W // 16
        tokens = rvm._tokenize(frame)
        enc = rvm._run_encoder(tokens)
        out, new_state = rvm.rnn_core(enc, state)
        D = out.shape[-1]
        feat = out[:, 1:, :].reshape(1, h, w, D).permute(0, 3, 1, 2)
        feat = (feat.float() - self.mean) / self.std
        return feat, new_state


class Stage1Piece(nn.Module):
    """One Hann window of stage 1.

    rgb (1,T,3,H,W) asinh, hint (1,T,1,H,W), hint_quality (1,T),
    moge (1,T,768,H/64,W/64), cradio (1,T,Cc,H/64,W/64), rvm (1,T,384,H/64,W/64)
    -> baton (1,T,512,H/16,W/16), aux (1,T,4,H/2,W/2)
    """

    def __init__(self, stage1):
        super().__init__()
        self.stage1 = stage1

    def forward(self, rgb, hint, hint_quality, moge, cradio, rvm):
        out = self.stage1(rgb, hint, moge, cradio_feat=cradio, rvm_feat=rvm,
                          t_stride=1.0, hint_quality=hint_quality)
        return out["baton"], out["aux"]


class Stage2Piece(nn.Module):
    """Per-frame stage 2: rgb (1,B,3,H,W), baton (1,B,512,H/16,W/16) -> logits (1,B,4,H,W)."""

    def __init__(self, stage2):
        super().__init__()
        self.stage2 = stage2

    def forward(self, rgb, baton):
        out = self.stage2(rgb, baton)
        if isinstance(out, tuple):
            out = out[0]
        return out
