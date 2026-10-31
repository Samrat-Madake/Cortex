// packages/percept/src/analyzers/clip-reid.ts
import type { ModelManager } from "../models/model-manager.js";
import { cropAndResize, normalizeImageToTensor } from "../models/preprocessing.js";
import { normalizeEmbedding } from "./adaface.js";
import type { BoundingBox } from "@reflectworld/shared";

/**
 * CLIP-ReID body ReID extractor.
 * Input: 256x128 body crop, ImageNet normalization.
 * Output: 768d L2-normalized embedding.
 * Supports batch inference (fixed batch=8).
 */
export class ClipReidExtractor {
  private modelManager: ModelManager;

  static readonly BATCH_SIZE = 8;
  static readonly CROP_W = 128;
  static readonly CROP_H = 256;
  static readonly EMBED_DIM = 768;
  private static readonly MEAN: [number, number, number] = [0.485, 0.456, 0.406];
  private static readonly STD: [number, number, number] = [0.229, 0.224, 0.225];

  constructor(modelManager: ModelManager) {
    this.modelManager = modelManager;
  }

  /** Extract body embedding from a single frame region. */
  async extract(frameBase64: string, bodyBbox: BoundingBox): Promise<Float32Array> {
    const results = await this.extractBatch([{ frameBase64, bbox: bodyBbox }]);
    return results[0]!;
  }

  /** Batch extract body embeddings. Up to BATCH_SIZE crops in one run. */
  async extractBatch(
    crops: Array<{ frameBase64: string; bbox: BoundingBox }>,
  ): Promise<Float32Array[]> {
    await this.modelManager.ensureLoaded("clip-reid-vitb");

    const BS = ClipReidExtractor.BATCH_SIZE;
    const W = ClipReidExtractor.CROP_W;
    const H = ClipReidExtractor.CROP_H;
    const frameSize = 3 * W * H;
    const numValid = Math.min(crops.length, BS);

    const preprocessed = await Promise.all(
      crops.slice(0, numValid).map(async ({ frameBase64, bbox }) => {
        const pixels = await cropAndResize(frameBase64, bbox.x, bbox.y, bbox.width, bbox.height, W, H);
        return normalizeImageToTensor(pixels, W, H, ClipReidExtractor.MEAN, ClipReidExtractor.STD);
      }),
    );

    const batchData = new Float32Array(BS * frameSize);
    for (let i = 0; i < numValid; i++) {
      batchData.set(preprocessed[i]!.data, i * frameSize);
    }

    const tensor = { data: batchData, dims: [BS, 3, H, W] };
    const outputs = await this.modelManager.engine.run("clip-reid-vitb", { input: tensor });

    const embeddingTensor = outputs["output"] ?? outputs["embedding"] ?? Object.values(outputs)[0];
    if (!embeddingTensor) throw new Error("CLIP-ReID output missing embedding tensor");

    const allData = embeddingTensor.data as Float32Array;
    const dim = ClipReidExtractor.EMBED_DIM;
    const results: Float32Array[] = [];
    for (let i = 0; i < numValid; i++) {
      const raw = allData.subarray(i * dim, (i + 1) * dim);
      results.push(normalizeEmbedding(new Float32Array(raw)));
    }
    return results;
  }
}
