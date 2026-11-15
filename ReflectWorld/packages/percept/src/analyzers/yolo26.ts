// packages/percept/src/analyzers/yolo26.ts
import type { ModelManager } from "../models/model-manager.js";
import type { BoundingBox } from "@cortex/shared";
import { resizeAndPad } from "../models/preprocessing.js";
import { YOLO_CONFIDENCE, YOLO_CLASS_CONFIDENCE } from "../thresholds.js";

/** COCO 80 class labels. */
export const COCO_LABELS: string[] = [
  "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train", "truck",
  "boat", "traffic light", "fire hydrant", "stop sign", "parking meter", "bench",
  "bird", "cat", "dog", "horse", "sheep", "cow", "elephant", "bear", "zebra",
  "giraffe", "backpack", "umbrella", "handbag", "tie", "suitcase", "frisbee",
  "skis", "snowboard", "sports ball", "kite", "baseball bat", "baseball glove",
  "skateboard", "surfboard", "tennis racket", "bottle", "wine glass", "cup",
  "fork", "knife", "spoon", "bowl", "banana", "apple", "sandwich", "orange",
  "broccoli", "carrot", "hot dog", "pizza", "donut", "cake", "chair", "couch",
  "potted plant", "bed", "dining table", "toilet", "tv", "laptop", "mouse",
  "remote", "keyboard", "cell phone", "microwave", "oven", "toaster", "sink",
  "refrigerator", "book", "clock", "vase", "scissors", "teddy bear",
  "hair drier", "toothbrush",
];

/**
 * Attention-relevant COCO classes for the perception VLM/tracking pipeline.
 *
 * NOTE: This set is NOT applied at the detector layer; Yolo26Detector returns
 * the full COCO-80 output so consumers can choose their own class policy.
 * Percept keeps the full external detection list, then narrows only the
 * tracking input to classes that can form stable entities.
 */
export const SECURITY_LABELS = new Set([
  "person", "bicycle", "car", "motorcycle", "bus", "train", "truck",
  "boat", "dog", "cat", "bird", "horse", "cow",
  "backpack", "umbrella", "handbag", "tie", "suitcase",
  "skateboard", "surfboard",
  "bottle", "cup", "knife", "scissors",
  "cell phone", "laptop",
  "fire hydrant",
]);

/** Narrow a list of detections to security-relevant COCO classes. */
export function filterSecurityLabels<T extends { label: string }>(dets: T[]): T[] {
  return dets.filter((d) => SECURITY_LABELS.has(d.label));
}

export interface Detection {
  label: string;
  confidence: number;
  bbox: BoundingBox;
}

/**
 * Decode YOLO26 output tensor into detection results.
 * Output format: output0 (1, 300, 6) — [x1, y1, x2, y2, confidence, class_id]
 * Coordinates are pixel values in the 640x640 input space.
 * Already NMS'd and decoded — zero post-processing needed.
 */
export function decodeYolo26Output(
  data: Float32Array,
  numDetections: number,
  opts: {
    confidenceThreshold: number;
    scale: number;
    padX: number;
    padY: number;
  },
): Detection[] {
  const results: Detection[] = [];

  for (let i = 0; i < numDetections; i++) {
    const confidence = data[i * 6 + 4]!;
    if (confidence < opts.confidenceThreshold) continue;

    const classId = Math.round(data[i * 6 + 5]!);
    const label = COCO_LABELS[classId] ?? `class_${classId}`;

    // Apply per-class confidence override (e.g. person → 0.7)
    const classThreshold = YOLO_CLASS_CONFIDENCE[label];
    if (classThreshold !== undefined && confidence < classThreshold) continue;

    // Map pixel coords from 640x640 input space to original image space
    const x1 = (data[i * 6]! - opts.padX) / opts.scale;
    const y1 = (data[i * 6 + 1]! - opts.padY) / opts.scale;
    const x2 = (data[i * 6 + 2]! - opts.padX) / opts.scale;
    const y2 = (data[i * 6 + 3]! - opts.padY) / opts.scale;

    results.push({
      label,
      confidence,
      bbox: { x: Math.max(0, x1), y: Math.max(0, y1), width: x2 - x1, height: y2 - y1 },
    });
  }

  return results;
}

/**
 * YOLO26 detector: preprocesses frames and runs ONNX inference.
 * Input: 640x640 letterboxed, /255 normalization (no ImageNet mean/std).
 */
export class Yolo26Detector {
  private modelManager: ModelManager;
  private confidenceThreshold: number;

  constructor(modelManager: ModelManager, confidenceThreshold?: number) {
    this.modelManager = modelManager;
    this.confidenceThreshold = confidenceThreshold ?? YOLO_CONFIDENCE;
  }

  static readonly BATCH_SIZE = 10;
  static readonly INPUT_SIZE = 640;

  /** Preprocess a single frame into a flat Float32Array (3*640*640). Returns scale/pad info. */
  private async preprocessFrame(frameBase64: string): Promise<{
    pixels: Float32Array;
    scale: number; padX: number; padY: number;
  }> {
    const { data, width, height, scale, padX, padY } =
      await resizeAndPad(frameBase64, Yolo26Detector.INPUT_SIZE, Yolo26Detector.INPUT_SIZE);
    const size = width * height;
    const pixels = new Float32Array(3 * size);
    for (let i = 0; i < size; i++) {
      for (let c = 0; c < 3; c++) {
        pixels[c * size + i] = data[i * 3 + c]! / 255;
      }
    }
    return { pixels, scale, padX, padY };
  }

  /** Detect objects in a single base64 JPEG frame (batch=1, CoreML optimized). */
  async detect(frameBase64: string): Promise<Detection[]> {
    await this.modelManager.ensureLoaded("yolo26m");

    const { pixels, scale, padX, padY } = await this.preprocessFrame(frameBase64);
    const tensor = await this.modelManager.engine.createTensor("float32", pixels, [1, 3, Yolo26Detector.INPUT_SIZE, Yolo26Detector.INPUT_SIZE]);

    const outputs = await this.modelManager.engine.run("yolo26m", { images: tensor });
    const outputTensor = outputs["output0"];
    if (!outputTensor) {
      throw new Error("YOLO26 output missing 'output0'. Found: " + Object.keys(outputs).join(", "));
    }

    // Return raw COCO-80 detections; consumers (Percept pipeline / VC)
    // apply their own class filters as appropriate.
    return decodeYolo26Output(outputTensor.data as Float32Array, outputTensor.dims[1]!, {
      confidenceThreshold: this.confidenceThreshold, scale, padX, padY,
    });
  }

  /**
   * Batch detection: process up to BATCH_SIZE frames in one session.run().
   * Pads with zero frames if fewer than BATCH_SIZE. Returns per-frame detections.
   */
  async detectBatch(framesBase64: string[]): Promise<Detection[][]> {
    await this.modelManager.ensureLoaded("yolo26m");

    const BS = Yolo26Detector.BATCH_SIZE;
    const SZ = Yolo26Detector.INPUT_SIZE;
    const frameSize = 3 * SZ * SZ;
    const numValid = Math.min(framesBase64.length, BS);

    // Preprocess all valid frames
    const preprocessed = await Promise.all(
      framesBase64.slice(0, numValid).map((f) => this.preprocessFrame(f)),
    );

    // Build batch tensor [BS, 3, SZ, SZ] — pad remaining with zeros
    const batchData = new Float32Array(BS * frameSize);
    for (let i = 0; i < numValid; i++) {
      batchData.set(preprocessed[i]!.pixels, i * frameSize);
    }
    // Remaining slots stay zero (black frames)

    const tensor = await this.modelManager.engine.createTensor("float32", batchData, [BS, 3, SZ, SZ]);
    const outputs = await this.modelManager.engine.run("yolo26m", { images: tensor });

    const outputTensor = outputs["output0"];
    if (!outputTensor) {
      throw new Error("YOLO26 output missing 'output0' tensor. Found: " + Object.keys(outputs).join(", "));
    }

    // Parse per-frame results: output shape [BS, 300, 6]
    const outputData = outputTensor.data as Float32Array;
    const numDetsPerFrame = outputTensor.dims[1]!;
    const colsPerDet = outputTensor.dims[2]!; // 6
    const frameOutputSize = numDetsPerFrame * colsPerDet;

    const results: Detection[][] = [];
    for (let f = 0; f < numValid; f++) {
      const frameData = outputData.subarray(f * frameOutputSize, (f + 1) * frameOutputSize);
      const { scale, padX, padY } = preprocessed[f]!;
      // Return raw COCO-80 detections; filtering is the consumer's responsibility.
      results.push(decodeYolo26Output(frameData, numDetsPerFrame, {
        confidenceThreshold: this.confidenceThreshold,
        scale, padX, padY,
      }));
    }

    return results;
  }
}
