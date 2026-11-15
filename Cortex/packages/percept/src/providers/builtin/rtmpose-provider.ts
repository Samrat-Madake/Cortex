// packages/percept/src/providers/builtin/rtmpose-provider.ts
import { OnnxBuiltinBase } from "./onnx-builtin-base.js";
import type { PoseProvider, InferInput, PoseOutput } from "../types.js";
import type { ModelManager } from "../../models/model-manager.js";
import { RtmPoseEstimator } from "../../analyzers/rtmpose.js";
import type { BoundingBox } from "@cortex/shared";

/**
 * Builtin ONNX provider wrapping RTMPose-s.
 * Input must include options.bbox for person bounding box.
 */
export class RtmPoseBuiltinProvider extends OnnxBuiltinBase implements PoseProvider {
  readonly name = "rtmpose-builtin";
  readonly type = "pose" as const;
  private estimator: RtmPoseEstimator;

  constructor(modelManager: ModelManager) {
    super(modelManager, "rtmpose-s");
    this.estimator = new RtmPoseEstimator(modelManager);
  }

  async estimatePose(input: InferInput): Promise<PoseOutput> {
    const bbox = input.options?.bbox as BoundingBox | undefined;
    if (!bbox) {
      throw new Error("RtmPoseBuiltinProvider requires options.bbox for person region");
    }
    const keypoints = await this.estimator.estimate(input.imageBuffer, bbox);
    return { keypoints };
  }
}
