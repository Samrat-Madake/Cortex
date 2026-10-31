#!/usr/bin/env python3
"""Export RetinaFace-ResNet50 to ONNX for ReflectWorld Level-1 face detection.

Architecture: standard RetinaFace with a ResNet50 backbone, adapted from
biubug6/Pytorch_Retinaface (MIT-licensed code). Self-contained: no external
repo clone required.

Output ONNX contract (must match what packages/percept expects):
    input : "input"    [1, 3, H, W]  (dynamic H/W)
    output: "bbox"     [1, anchors, 4]
            "cls"      [1, anchors, 2]   (softmax scores)
            "landmark" [1, anchors, 10]
    opset : 11

Weights: `Resnet50_Final.pth` from biubug6/Pytorch_Retinaface.

LICENSE NOTICE
    The pretrained weights are trained on the WIDER FACE dataset, which is
    licensed for NON-COMMERCIAL RESEARCH USE ONLY. Verify licensing before any
    commercial deployment. This script neither downloads nor redistributes
    weights; you must obtain them yourself and accept their license.

Usage:
    python export_retinaface.py --weights Resnet50_Final.pth --output retinaface-resnet50.onnx
    python export_retinaface.py --weights ... --output ... --verify reference.onnx --accept-license
"""
import argparse
import sys
from pathlib import Path

import torch
import torch.nn as nn
import torch.nn.functional as F
import torchvision.models as models
import torchvision.models._utils as _utils

# RetinaFace-ResNet50 config (biubug6/Pytorch_Retinaface data/config.py cfg_re50)
CFG = {
    "return_layers": {"layer2": 1, "layer3": 2, "layer4": 3},
    "in_channel": 256,
    "out_channel": 256,
}


def conv_bn(inp, oup, stride=1, leaky=0):
    return nn.Sequential(
        nn.Conv2d(inp, oup, 3, stride, 1, bias=False),
        nn.BatchNorm2d(oup),
        nn.LeakyReLU(negative_slope=leaky, inplace=True),
    )


def conv_bn_no_relu(inp, oup, stride):
    return nn.Sequential(
        nn.Conv2d(inp, oup, 3, stride, 1, bias=False),
        nn.BatchNorm2d(oup),
    )


def conv_bn1x1(inp, oup, stride, leaky=0):
    return nn.Sequential(
        nn.Conv2d(inp, oup, 1, stride, padding=0, bias=False),
        nn.BatchNorm2d(oup),
        nn.LeakyReLU(negative_slope=leaky, inplace=True),
    )


class SSH(nn.Module):
    """Single-stage headless context module."""

    def __init__(self, in_channel, out_channel):
        super().__init__()
        assert out_channel % 4 == 0
        leaky = 0.1 if out_channel <= 64 else 0
        self.conv3X3 = conv_bn_no_relu(in_channel, out_channel // 2, stride=1)
        self.conv5X5_1 = conv_bn(in_channel, out_channel // 4, stride=1, leaky=leaky)
        self.conv5X5_2 = conv_bn_no_relu(out_channel // 4, out_channel // 4, stride=1)
        self.conv7X7_2 = conv_bn(out_channel // 4, out_channel // 4, stride=1, leaky=leaky)
        self.conv7x7_3 = conv_bn_no_relu(out_channel // 4, out_channel // 4, stride=1)

    def forward(self, x):
        conv3X3 = self.conv3X3(x)
        conv5X5_1 = self.conv5X5_1(x)
        conv5X5 = self.conv5X5_2(conv5X5_1)
        conv7X7_2 = self.conv7X7_2(conv5X5_1)
        conv7X7 = self.conv7x7_3(conv7X7_2)
        out = torch.cat([conv3X3, conv5X5, conv7X7], dim=1)
        return F.relu(out)


class FPN(nn.Module):
    """Feature Pyramid Network over three backbone stages."""

    def __init__(self, in_channels_list, out_channels):
        super().__init__()
        leaky = 0.1 if out_channels <= 64 else 0
        self.output1 = conv_bn1x1(in_channels_list[0], out_channels, stride=1, leaky=leaky)
        self.output2 = conv_bn1x1(in_channels_list[1], out_channels, stride=1, leaky=leaky)
        self.output3 = conv_bn1x1(in_channels_list[2], out_channels, stride=1, leaky=leaky)
        self.merge1 = conv_bn(out_channels, out_channels, leaky=leaky)
        self.merge2 = conv_bn(out_channels, out_channels, leaky=leaky)

    def forward(self, x):
        x = list(x.values())
        output1 = self.output1(x[0])
        output2 = self.output2(x[1])
        output3 = self.output3(x[2])
        up3 = F.interpolate(output3, size=[output2.size(2), output2.size(3)], mode="nearest")
        output2 = self.merge2(output2 + up3)
        up2 = F.interpolate(output2, size=[output1.size(2), output1.size(3)], mode="nearest")
        output1 = self.merge1(output1 + up2)
        return [output1, output2, output3]


class ClassHead(nn.Module):
    def __init__(self, inchannels=512, num_anchors=2):
        super().__init__()
        self.conv1x1 = nn.Conv2d(inchannels, num_anchors * 2, kernel_size=(1, 1), stride=1, padding=0)

    def forward(self, x):
        out = self.conv1x1(x).permute(0, 2, 3, 1).contiguous()
        return out.view(out.shape[0], -1, 2)


class BboxHead(nn.Module):
    def __init__(self, inchannels=512, num_anchors=2):
        super().__init__()
        self.conv1x1 = nn.Conv2d(inchannels, num_anchors * 4, kernel_size=(1, 1), stride=1, padding=0)

    def forward(self, x):
        out = self.conv1x1(x).permute(0, 2, 3, 1).contiguous()
        return out.view(out.shape[0], -1, 4)


class LandmarkHead(nn.Module):
    def __init__(self, inchannels=512, num_anchors=2):
        super().__init__()
        self.conv1x1 = nn.Conv2d(inchannels, num_anchors * 10, kernel_size=(1, 1), stride=1, padding=0)

    def forward(self, x):
        out = self.conv1x1(x).permute(0, 2, 3, 1).contiguous()
        return out.view(out.shape[0], -1, 10)


class RetinaFace(nn.Module):
    """RetinaFace-ResNet50. Test-phase forward returns (bbox, softmax(cls), landmark)."""

    def __init__(self):
        super().__init__()
        backbone = models.resnet50(weights=None)  # weights loaded from checkpoint below
        self.body = _utils.IntermediateLayerGetter(backbone, CFG["return_layers"])
        c = CFG["in_channel"]
        in_channels_list = [c * 2, c * 4, c * 8]
        out_channels = CFG["out_channel"]
        self.fpn = FPN(in_channels_list, out_channels)
        self.ssh1 = SSH(out_channels, out_channels)
        self.ssh2 = SSH(out_channels, out_channels)
        self.ssh3 = SSH(out_channels, out_channels)
        self.ClassHead = nn.ModuleList([ClassHead(out_channels, 2) for _ in range(3)])
        self.BboxHead = nn.ModuleList([BboxHead(out_channels, 2) for _ in range(3)])
        self.LandmarkHead = nn.ModuleList([LandmarkHead(out_channels, 2) for _ in range(3)])

    def forward(self, inputs):
        out = self.body(inputs)
        fpn = self.fpn(out)
        features = [self.ssh1(fpn[0]), self.ssh2(fpn[1]), self.ssh3(fpn[2])]
        bbox = torch.cat([self.BboxHead[i](f) for i, f in enumerate(features)], dim=1)
        cls = torch.cat([self.ClassHead[i](f) for i, f in enumerate(features)], dim=1)
        landmark = torch.cat([self.LandmarkHead[i](f) for i, f in enumerate(features)], dim=1)
        return bbox, F.softmax(cls, dim=-1), landmark


def build_model(weights_path: Path) -> RetinaFace:
    model = RetinaFace()
    try:
        sd = torch.load(str(weights_path), map_location="cpu", weights_only=True)
    except Exception:
        sd = torch.load(str(weights_path), map_location="cpu", weights_only=False)
    sd = {(k[7:] if k.startswith("module.") else k): v for k, v in sd.items()}
    missing, unexpected = model.load_state_dict(sd, strict=False)
    if missing:
        raise SystemExit(
            f"[error] incomplete weights: {len(missing)} model parameter(s) not found in the "
            f"checkpoint (e.g. {missing[:3]}). Wrong or corrupt Resnet50_Final.pth — refusing to "
            f"export a semantically-invalid model."
        )
    if unexpected:
        print(f"  [warn] {len(unexpected)} unexpected key(s) in checkpoint (ignored)")
    print("  [ok] weights loaded (missing=0)")
    model.eval()
    return model


def export_onnx(model: RetinaFace, output_path: Path) -> None:
    dummy = torch.randn(1, 3, 640, 640)
    torch.onnx.export(
        model, dummy, str(output_path),
        input_names=["input"], output_names=["bbox", "cls", "landmark"],
        opset_version=11, dynamo=False,
        dynamic_axes={"input": {2: "height", 3: "width"},
                      "bbox": {1: "anchors"}, "cls": {1: "anchors"}, "landmark": {1: "anchors"}},
    )
    print(f"  [ok] exported ONNX -> {output_path}")


def verify_against(new_path: Path, ref_path: Path) -> bool:
    import numpy as np
    import onnxruntime as ort
    ref = ort.InferenceSession(str(ref_path), providers=["CPUExecutionProvider"])
    new = ort.InferenceSession(str(new_path), providers=["CPUExecutionProvider"])
    x = np.random.rand(1, 3, 640, 640).astype(np.float32)
    r = ref.run(None, {ref.get_inputs()[0].name: x})
    n = new.run(None, {new.get_inputs()[0].name: x})
    ok = True
    for i, (a, b) in enumerate(zip(r, n)):
        if a.shape != b.shape:
            print(f"  [verify] out{i} SHAPE MISMATCH {a.shape} vs {b.shape}"); ok = False; continue
        d = float(np.abs(a.astype("float64") - b.astype("float64")).max())
        print(f"  [verify] out{i} {['bbox','cls','landmark'][i]} shape {a.shape} max_abs_diff {d:.2e}")
        ok = ok and d < 1e-4
    return ok


LICENSE_NOTICE = """\
──────────────────────────────────────────────────────────────────────────
RetinaFace-ResNet50 weights are trained on WIDER FACE, licensed for
NON-COMMERCIAL RESEARCH USE ONLY. This script neither downloads nor
redistributes weights — you must obtain Resnet50_Final.pth yourself
(biubug6/Pytorch_Retinaface) and comply with its license.
Commercial use requires substituting a commercially-licensed model.
──────────────────────────────────────────────────────────────────────────"""


def main() -> None:
    ap = argparse.ArgumentParser(description="Export RetinaFace-ResNet50 to ONNX")
    ap.add_argument("--weights", required=True, type=Path, help="Path to Resnet50_Final.pth")
    ap.add_argument("--output", required=True, type=Path, help="Output .onnx path")
    ap.add_argument("--verify", type=Path, default=None, help="Optional reference .onnx to numerically compare")
    ap.add_argument("--accept-license", action="store_true", help="Acknowledge the non-commercial weight license")
    args = ap.parse_args()

    print(LICENSE_NOTICE)
    if not args.accept_license:
        resp = input("Type 'yes' to acknowledge the non-commercial license and continue: ").strip().lower()
        if resp != "yes":
            print("Aborted."); sys.exit(1)

    if not args.weights.exists():
        print(f"[error] weights not found: {args.weights}"); sys.exit(1)

    print("Building model + loading weights...")
    model = build_model(args.weights)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    print("Exporting ONNX...")
    export_onnx(model, args.output)

    if args.verify:
        print("Verifying against reference ONNX...")
        ok = verify_against(args.output, args.verify)
        print("VERIFY:", "MATCH" if ok else "DIFFER")
        sys.exit(0 if ok else 2)


if __name__ == "__main__":
    main()
