// packages/percept/src/providers/builtin/adaface-provider.ts
import { OnnxBuiltinBase } from "./onnx-builtin-base.js";
import type { ReidProvider, InferInput, ReidOutput } from "../types.js";
import type { ModelManager } from "../../models/model-manager.js";
import { AdaFaceExtractor } from "../../analyzers/adaface.js";
import type { BoundingBox } from "@cortex/shared";

/**
 * Builtin ONNX provider wrapping the ArcFace MobileFaceNet extractor.
 * Input must include options.bbox for face region.
 * Optionally accepts options.landmarks for 5-point alignment.
 */
export class AdaFaceBuiltinProvider extends OnnxBuiltinBase implements ReidProvider {
  readonly name = "adaface-builtin";
  readonly type = "reid" as const;
  private extractor: AdaFaceExtractor;

  constructor(modelManager: ModelManager) {
    super(modelManager, "arcface-mbf");
    this.extractor = new AdaFaceExtractor(modelManager);
  }

  async extractEmbedding(input: InferInput): Promise<ReidOutput> {
    const bbox = input.options?.bbox as BoundingBox | undefined;
    if (!bbox) {
      throw new Error("AdaFaceBuiltinProvider requires options.bbox for face crop region");
    }

    const landmarks = input.options?.landmarks as Array<{ x: number; y: number }> | undefined;
    const base64 = input.imageBuffer.toString("base64");
    const embedding = await this.extractor.extract(base64, bbox, landmarks);

    if (!embedding) {
      return { embedding: [], embedding_dim: 0 };
    }

    return {
      embedding: Array.from(embedding),
      embedding_dim: 512,
    };
  }
}
