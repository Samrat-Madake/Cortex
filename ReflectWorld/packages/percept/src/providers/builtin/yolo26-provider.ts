// packages/percept/src/providers/builtin/yolo26-provider.ts
import { OnnxBuiltinBase } from "./onnx-builtin-base.js";
import type { DetectorProvider, InferInput, DetectorOutput } from "../types.js";
import type { ModelManager } from "../../models/model-manager.js";
import { Yolo26Detector } from "../../analyzers/yolo26.js";
import { YOLO_CONFIDENCE } from "../../thresholds.js";

/**
 * Builtin ONNX provider wrapping the Yolo26Detector.
 * Reuses all existing preprocessing/postprocessing logic.
 */
export class Yolo26BuiltinProvider extends OnnxBuiltinBase implements DetectorProvider {
  readonly name = "yolo26m-builtin";
  readonly type = "detector" as const;
  private detector: Yolo26Detector;

  constructor(modelManager: ModelManager, confidenceThreshold = YOLO_CONFIDENCE) {
    super(modelManager, "yolo26m");
    this.detector = new Yolo26Detector(modelManager, confidenceThreshold);
  }

  async detect(input: InferInput): Promise<DetectorOutput> {
    const base64 = input.imageBuffer.toString("base64");
    const detections = await this.detector.detect(base64);

    return {
      boxes: detections.map((d) => ({
        x1: d.bbox.x,
        y1: d.bbox.y,
        x2: d.bbox.x + d.bbox.width,
        y2: d.bbox.y + d.bbox.height,
        confidence: d.confidence,
        class_id: 0,
        class_name: d.label,
      })),
    };
  }
}
