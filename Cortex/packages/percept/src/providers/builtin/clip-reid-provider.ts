// packages/percept/src/providers/builtin/clip-reid-provider.ts
import { OnnxBuiltinBase } from "./onnx-builtin-base.js";
import type { ReidProvider, InferInput, ReidOutput } from "../types.js";
import type { ModelManager } from "../../models/model-manager.js";
import { ClipReidExtractor } from "../../analyzers/clip-reid.js";
import type { BoundingBox } from "@cortex/shared";

/**
 * Builtin ONNX provider wrapping the ClipReidExtractor.
 * Input must include options.bbox for body crop region.
 */
export class ClipReidBuiltinProvider extends OnnxBuiltinBase implements ReidProvider {
  readonly name = "clip-reid-builtin";
  readonly type = "reid" as const;
  private extractor: ClipReidExtractor;

  constructor(modelManager: ModelManager) {
    super(modelManager, "clip-reid-vitb");
    this.extractor = new ClipReidExtractor(modelManager);
  }

  async extractEmbedding(input: InferInput): Promise<ReidOutput> {
    const bbox = input.options?.bbox as BoundingBox | undefined;
    if (!bbox) {
      throw new Error("ClipReidBuiltinProvider requires options.bbox for body crop region");
    }

    const base64 = input.imageBuffer.toString("base64");
    const embedding = await this.extractor.extract(base64, bbox);

    return {
      embedding: Array.from(embedding),
      embedding_dim: 768,
    };
  }
}
