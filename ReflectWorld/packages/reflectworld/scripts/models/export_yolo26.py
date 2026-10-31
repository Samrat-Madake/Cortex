#!/usr/bin/env python3
"""Export YOLO26m to ONNX for ReflectWorld Level-1 object detection.

Thin wrapper over the official Ultralytics exporter. YOLO26 is NMS-free, so the
ONNX natively outputs decoded top-K detections.

Output ONNX contract (matches production):
    input : "images"  [1, 3, 640, 640]
    output: "output0" [1, 300, 6]   (NMS-free: top-300 x [x,y,w,h,conf,cls])
    opset : 17

Weights: `yolo26m.pt` (Ultralytics official).

LICENSE NOTICE
    YOLO26 (Ultralytics) is licensed under AGPL-3.0. Commercial use requires an
    Ultralytics Enterprise License. This script neither redistributes weights nor
    changes that obligation.

Usage:
    python export_yolo26.py --weights yolo26m.pt --output yolo26m.onnx
    python export_yolo26.py --weights ... --output ... --verify reference.onnx --accept-license
"""
import argparse
import shutil
import sys
from pathlib import Path

LICENSE_NOTICE = """\
──────────────────────────────────────────────────────────────────────────
YOLO26 (Ultralytics) is licensed under AGPL-3.0. Any commercial or networked
use requires compliance with AGPL-3.0 or an Ultralytics Enterprise License.
──────────────────────────────────────────────────────────────────────────"""


def export_onnx(weights: Path, output: Path) -> None:
    from ultralytics import YOLO

    # Export next to a temp copy so we never clobber the source directory.
    tmp = output.parent / "_yolo_export_tmp"
    tmp.mkdir(parents=True, exist_ok=True)
    tmp_pt = tmp / weights.name
    shutil.copy(str(weights), str(tmp_pt))

    model = YOLO(str(tmp_pt))
    produced = model.export(format="onnx", opset=17, simplify=True, dynamic=False, nms=False, batch=1)
    shutil.move(str(produced), str(output))
    shutil.rmtree(tmp, ignore_errors=True)
    print(f"  [ok] exported ONNX -> {output}")


def verify_against(new_path: Path, ref_path: Path) -> bool:
    import numpy as np
    import onnxruntime as ort

    ref = ort.InferenceSession(str(ref_path), providers=["CPUExecutionProvider"])
    new = ort.InferenceSession(str(new_path), providers=["CPUExecutionProvider"])
    ishape = [d if isinstance(d, int) else 640 for d in ref.get_inputs()[0].shape]
    x = np.random.rand(*ishape).astype(np.float32)
    r = ref.run(None, {ref.get_inputs()[0].name: x})
    n = new.run(None, {new.get_inputs()[0].name: x})
    ok = True
    for i, (a, b) in enumerate(zip(r, n)):
        if a.shape != b.shape:
            print(f"  [verify] out{i} SHAPE MISMATCH {a.shape} vs {b.shape}"); ok = False; continue
        d = float(np.abs(a.astype("float64") - b.astype("float64")).max())
        print(f"  [verify] out{i} shape {a.shape} max_abs_diff {d:.2e}")
        ok = ok and d < 1e-4
    return ok


def main() -> None:
    ap = argparse.ArgumentParser(description="Export YOLO26m to ONNX")
    ap.add_argument("--weights", required=True, type=Path, help="Path to yolo26m.pt")
    ap.add_argument("--output", required=True, type=Path, help="Output .onnx path")
    ap.add_argument("--verify", type=Path, default=None, help="Optional reference .onnx to compare")
    ap.add_argument("--accept-license", action="store_true", help="Acknowledge AGPL-3.0")
    args = ap.parse_args()

    print(LICENSE_NOTICE)
    if not args.accept_license:
        if input("Type 'yes' to acknowledge AGPL-3.0 and continue: ").strip().lower() != "yes":
            print("Aborted."); sys.exit(1)
    if not args.weights.exists():
        print(f"[error] weights not found: {args.weights}"); sys.exit(1)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    export_onnx(args.weights, args.output)

    if args.verify:
        ok = verify_against(args.output, args.verify)
        print("VERIFY:", "MATCH" if ok else "DIFFER")
        sys.exit(0 if ok else 2)


if __name__ == "__main__":
    main()
