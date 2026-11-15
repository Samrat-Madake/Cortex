// packages/percept/src/providers/builtin/retinaface-provider.ts
import { OnnxBuiltinBase } from "./onnx-builtin-base.js";
import type { DetectorProvider, InferInput, DetectorOutput } from "../types.js";
import type { ModelManager } from "../../models/model-manager.js";
import { RetinaFaceDetector } from "../../analyzers/retinaface.js";
import { FACE_PROVIDER_CONFIDENCE } from "../../thresholds.js";

/**
 * Builtin ONNX provider wrapping the RetinaFaceDetector.
 * Outputs face bounding boxes with class_name="face".
 */
export class RetinaFaceBuiltinProvider extends OnnxBuiltinBase implements DetectorProvider {
  readonly name = "retinaface-builtin";
  readonly type = "detector" as const;
  private detector: RetinaFaceDetector;

  constructor(modelManager: ModelManager, confidenceThreshold = FACE_PROVIDER_CONFIDENCE) {
    super(modelManager, "retinaface-resnet50");
    this.detector = new RetinaFaceDetector(modelManager, { confidenceThreshold });
  }

  async detect(input: InferInput): Promise<DetectorOutput> {
    const base64 = input.imageBuffer.toString("base64");
    const { faces: faceDetections, debug } = await this.detector.detectWithDebug(base64);

    return {
      boxes: faceDetections.map((fd) => ({
        x1: fd.bbox.x,
        y1: fd.bbox.y,
        x2: fd.bbox.x + fd.bbox.width,
        y2: fd.bbox.y + fd.bbox.height,
        confidence: fd.confidence,
        class_id: -1, // Special: face class
        class_name: "face",
        landmarks: fd.landmarks,
      })),
      debug: { ...debug },
    };
  }
}
