#!/usr/bin/env python3
"""Export CLIP-ReID ViT-B/16 to ONNX for Cortex body ReID (optional, default-disabled).

Architecture: CLIP ViT-B/16 vision transformer (image encoder only), adapted from
Syliz517/CLIP-ReID. Self-contained: no external repo clone required.

Output ONNX contract (matches production):
    input : "input"     [8, 3, 256, 128]   (FIXED batch=8 — percept pads to 8)
    output: "embedding" [8, 768]            (L2-normalized)
    opset : 18

Weights: CLIP-ReID ViT-B/16 trained on Market-1501 (Syliz517/CLIP-ReID).

LICENSE NOTICE
    CLIP-ReID weights are trained on person-ReID datasets (Market-1501) intended
    for RESEARCH USE. Verify licensing before commercial deployment. This script
    neither redistributes weights nor changes that obligation.

Usage:
    python export_clipreid.py --weights clip_reid_market.pth --output clip-reid-vitb.onnx
    python export_clipreid.py --weights ... --output ... --verify reference.onnx --accept-license
"""
import argparse
import sys
from collections import OrderedDict
from pathlib import Path

import torch
import torch.nn as nn
import torch.nn.functional as F

BATCH = 8  # production uses a fixed batch of 8 (percept ClipReidExtractor.BATCH_SIZE)


class QuickGELU(nn.Module):
    def forward(self, x):
        return x * torch.sigmoid(1.702 * x)


class ResidualAttentionBlock(nn.Module):
    def __init__(self, d_model, n_head):
        super().__init__()
        self.attn = nn.MultiheadAttention(d_model, n_head)
        self.ln_1 = nn.LayerNorm(d_model)
        self.mlp = nn.Sequential(OrderedDict([
            ("c_fc", nn.Linear(d_model, d_model * 4)),
            ("gelu", QuickGELU()),
            ("c_proj", nn.Linear(d_model * 4, d_model)),
        ]))
        self.ln_2 = nn.LayerNorm(d_model)

    def forward(self, x):
        y = self.ln_1(x)
        y, _ = self.attn(y, y, y, need_weights=False)
        x = x + y
        x = x + self.mlp(self.ln_2(x))
        return x


class CLIPVisionTransformer(nn.Module):
    def __init__(self, input_resolution=(256, 128), patch_size=16, width=768, layers=12, heads=12):
        super().__init__()
        self.conv1 = nn.Conv2d(3, width, kernel_size=patch_size, stride=patch_size, bias=False)
        h, w = input_resolution
        num_patches = (h // patch_size) * (w // patch_size)
        self.class_embedding = nn.Parameter(torch.randn(width))
        self.positional_embedding = nn.Parameter(torch.randn(num_patches + 1, width))
        self.ln_pre = nn.LayerNorm(width)
        self.transformer = nn.Module()
        self.transformer.resblocks = nn.Sequential(
            *[ResidualAttentionBlock(width, heads) for _ in range(layers)]
        )
        self.ln_post = nn.LayerNorm(width)

    def forward(self, x):
        x = self.conv1(x)
        x = x.reshape(x.shape[0], x.shape[1], -1).permute(0, 2, 1)
        cls = self.class_embedding.unsqueeze(0).unsqueeze(0).expand(x.shape[0], -1, -1)
        x = torch.cat([cls, x], dim=1) + self.positional_embedding
        x = self.ln_pre(x)
        x = x.permute(1, 0, 2)
        x = self.transformer.resblocks(x)
        x = x.permute(1, 0, 2)
        x = self.ln_post(x[:, 0, :])
        return F.normalize(x, p=2, dim=1)


def build_model(weights_path: Path) -> CLIPVisionTransformer:
    model = CLIPVisionTransformer(input_resolution=(256, 128))
    ckpt = torch.load(str(weights_path), map_location="cpu", weights_only=False)
    if isinstance(ckpt, dict):
        state_dict = ckpt.get("model_state_dict", ckpt.get("state_dict", ckpt))
    else:
        state_dict = ckpt

    # Extract image-encoder weights (strip "image_encoder." prefix).
    adapted = OrderedDict()
    prefix = "image_encoder."
    for k, v in state_dict.items():
        if k.startswith(prefix):
            adapted[k[len(prefix):]] = v
    if not adapted:
        adapted = {k: v for k, v in state_dict.items()
                   if not any(s in k for s in ["classifier", "bottleneck", "text_encoder", "prompt_learner", "proj"])}
    adapted.pop("proj", None)

    result = model.load_state_dict(adapted, strict=False)
    total = len(model.state_dict())
    loaded = total - len(result.missing_keys)
    if result.missing_keys:
        raise SystemExit(
            f"[error] incomplete weights: {len(result.missing_keys)} of {total} image-encoder "
            f"parameter(s) missing from the checkpoint (e.g. {result.missing_keys[:3]}). Wrong or "
            f"corrupt CLIP-ReID checkpoint — refusing to export a semantically-invalid model."
        )
    print(f"  [ok] weights loaded ({loaded}/{total} keys, missing=0)")
    model.eval()
    return model


def export_onnx(model: CLIPVisionTransformer, output_path: Path) -> None:
    dummy = torch.randn(BATCH, 3, 256, 128)
    torch.onnx.export(
        model, dummy, str(output_path),
        input_names=["input"], output_names=["embedding"],
        opset_version=18, dynamo=False,
    )
    print(f"  [ok] exported ONNX -> {output_path}")


def verify_against(new_path: Path, ref_path: Path) -> bool:
    import numpy as np
    import onnxruntime as ort
    ref = ort.InferenceSession(str(ref_path), providers=["CPUExecutionProvider"])
    new = ort.InferenceSession(str(new_path), providers=["CPUExecutionProvider"])
    x = np.random.rand(BATCH, 3, 256, 128).astype(np.float32)
    r = ref.run(None, {ref.get_inputs()[0].name: x})
    n = new.run(None, {new.get_inputs()[0].name: x})
    ok = True
    for i, (a, b) in enumerate(zip(r, n)):
        if a.shape != b.shape:
            print(f"  [verify] out{i} SHAPE MISMATCH {a.shape} vs {b.shape}"); ok = False; continue
        d = float(np.abs(a.astype("float64") - b.astype("float64")).max())
        print(f"  [verify] out{i} embedding shape {a.shape} max_abs_diff {d:.2e}")
        ok = ok and d < 1e-4
    return ok


LICENSE_NOTICE = """\
──────────────────────────────────────────────────────────────────────────
CLIP-ReID weights are trained on person-ReID datasets (Market-1501) intended
for RESEARCH USE. This script neither downloads nor redistributes weights —
obtain them yourself (Syliz517/CLIP-ReID) and comply with their license.
──────────────────────────────────────────────────────────────────────────"""


def main() -> None:
    ap = argparse.ArgumentParser(description="Export CLIP-ReID ViT-B/16 to ONNX")
    ap.add_argument("--weights", required=True, type=Path, help="Path to clip_reid_market.pth")
    ap.add_argument("--output", required=True, type=Path, help="Output .onnx path")
    ap.add_argument("--verify", type=Path, default=None, help="Optional reference .onnx to compare")
    ap.add_argument("--accept-license", action="store_true", help="Acknowledge research-use license")
    args = ap.parse_args()

    print(LICENSE_NOTICE)
    if not args.accept_license:
        if input("Type 'yes' to acknowledge the research-use license and continue: ").strip().lower() != "yes":
            print("Aborted."); sys.exit(1)
    if not args.weights.exists():
        print(f"[error] weights not found: {args.weights}"); sys.exit(1)

    print("Building model + loading weights...")
    model = build_model(args.weights)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    print("Exporting ONNX...")
    export_onnx(model, args.output)

    if args.verify:
        ok = verify_against(args.output, args.verify)
        print("VERIFY:", "MATCH" if ok else "DIFFER")
        sys.exit(0 if ok else 2)


if __name__ == "__main__":
    main()
