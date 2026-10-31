// packages/percept/src/analyzers/retinaface.ts
import type { ModelManager } from "../models/model-manager.js";
import type { FaceDetection } from "../types.js";
import { FACE_PRE_NMS_CONFIDENCE, FACE_VIS_CONFIDENCE } from "../thresholds.js";

// Dynamic import for sharp (optional dependency)
let sharpFn: any = null;
async function getSharp(): Promise<any> {
  if (sharpFn) return sharpFn;
  const mod = await import("sharp");
  sharpFn = mod.default ?? mod;
  return sharpFn;
}

export interface RetinaFaceDecodeOptions {
  /** Initial confidence threshold for pre-NMS filtering (reference default: 0.02). */
  confidenceThreshold: number;
  /** Visual confidence threshold applied after NMS (reference default: 0.6). */
  visThreshold: number;
  /** Maximum detections to keep before NMS (reference default: 5000). */
  topK: number;
  /** Maximum detections to keep after NMS (reference default: 750). */
  keepTopK: number;
  /** NMS IoU threshold (reference default: 0.4). */
  nmsThreshold: number;
  /** Minimum face short-side size in pixels. Smaller faces are ignored before ReID. */
  minFaceSize: number;
  /** Letterbox scale factor used during preprocessing. */
  scale: number;
  /** Horizontal padding added during letterbox. */
  padX: number;
  /** Vertical padding added during letterbox. */
  padY: number;
}

export interface RetinaFaceDecodeDebug {
  anchors: number;
  pre_nms_confidence_threshold: number;
  vis_confidence_threshold: number;
  min_face_size: number;
  pre_nms_candidates: number;
  top_k_candidates: number;
  decoded_boxes: number;
  invalid_boxes: number;
  nms_kept: number;
  after_keep_top_k: number;
  rejected_by_vis_confidence: number;
  rejected_by_min_face_size: number;
  output_faces: number;
}

// ── RetinaFace ResNet50 config (from Pytorch_Retinaface/data/config.py) ──
const CFG_RE50 = {
  min_sizes: [[16, 32], [64, 128], [256, 512]] as number[][],
  steps: [8, 16, 32],
  variance: [0.1, 0.2] as [number, number],
};
const DEFAULT_MIN_FACE_SIZE = 40;

/** Cached prior boxes per image size to avoid regeneration. */
const priorCache = new Map<string, Float32Array>();

/**
 * Generate prior (anchor) boxes for RetinaFace.
 * Anchors are in normalized [cx, cy, w, h] format (0~1 relative to imageSize).
 * Ported from the reference RetinaFace implementation — PriorBox.
 */
export function generatePriors(imageH: number, imageW: number): Float32Array {
  const key = `${imageH}x${imageW}`;
  const cached = priorCache.get(key);
  if (cached) return cached;

  const anchors: number[] = [];
  const featureMaps = CFG_RE50.steps.map((step) => [
    Math.ceil(imageH / step),
    Math.ceil(imageW / step),
  ]);

  for (let k = 0; k < featureMaps.length; k++) {
    const [fH, fW] = featureMaps[k]!;
    const minSizes = CFG_RE50.min_sizes[k]!;
    for (let i = 0; i < fH; i++) {
      for (let j = 0; j < fW; j++) {
        for (const minSize of minSizes) {
          const sKx = minSize / imageW;
          const sKy = minSize / imageH;
          const cx = (j + 0.5) * CFG_RE50.steps[k]! / imageW;
          const cy = (i + 0.5) * CFG_RE50.steps[k]! / imageH;
          anchors.push(cx, cy, sKx, sKy);
        }
      }
    }
  }

  const result = new Float32Array(anchors);
  priorCache.set(key, result);
  return result;
}

/**
 * Decode bbox offsets using prior boxes.
 * Ported from the reference RetinaFace implementation — decode().
 *
 * loc: [N, 4] raw bbox regression outputs (offsets)
 * priors: [N, 4] anchor boxes in [cx, cy, w, h] normalized format
 * Returns decoded boxes in [x1, y1, x2, y2] pixel coordinates.
 */
function decodeBBoxes(
  loc: Float32Array, priors: Float32Array, N: number, imageW: number, imageH: number,
): Float32Array {
  const [var0, var1] = CFG_RE50.variance;
  const result = new Float32Array(N * 4);

  for (let i = 0; i < N; i++) {
    const pCx = priors[i * 4]!;
    const pCy = priors[i * 4 + 1]!;
    const pW = priors[i * 4 + 2]!;
    const pH = priors[i * 4 + 3]!;

    // Decode: center = prior_center + offset * variance * prior_size
    const cx = (pCx + loc[i * 4]! * var0 * pW) * imageW;
    const cy = (pCy + loc[i * 4 + 1]! * var0 * pH) * imageH;
    // Decode: size = prior_size * exp(offset * variance)
    const w = (pW * Math.exp(loc[i * 4 + 2]! * var1)) * imageW;
    const h = (pH * Math.exp(loc[i * 4 + 3]! * var1)) * imageH;

    // Center form → corner form
    result[i * 4] = cx - w / 2;     // x1
    result[i * 4 + 1] = cy - h / 2; // y1
    result[i * 4 + 2] = cx + w / 2; // x2
    result[i * 4 + 3] = cy + h / 2; // y2
  }
  return result;
}

/**
 * Decode landmark offsets using prior boxes.
 * Ported from the reference RetinaFace implementation — decode_landm().
 */
function decodeLandmarks(
  pre: Float32Array, priors: Float32Array, N: number, imageW: number, imageH: number,
): Float32Array {
  const var0 = CFG_RE50.variance[0];
  const result = new Float32Array(N * 10);

  for (let i = 0; i < N; i++) {
    const pCx = priors[i * 4]!;
    const pCy = priors[i * 4 + 1]!;
    const pW = priors[i * 4 + 2]!;
    const pH = priors[i * 4 + 3]!;

    for (let j = 0; j < 5; j++) {
      result[i * 10 + j * 2] = (pCx + pre[i * 10 + j * 2]! * var0 * pW) * imageW;
      result[i * 10 + j * 2 + 1] = (pCy + pre[i * 10 + j * 2 + 1]! * var0 * pH) * imageH;
    }
  }
  return result;
}

/** IoU between two boxes in {x1,y1,x2,y2} format. */
function iou(a: { x1: number; y1: number; x2: number; y2: number }, b: { x1: number; y1: number; x2: number; y2: number }): number {
  const ix1 = Math.max(a.x1, b.x1), iy1 = Math.max(a.y1, b.y1);
  const ix2 = Math.min(a.x2, b.x2), iy2 = Math.min(a.y2, b.y2);
  const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
  const aArea = (a.x2 - a.x1) * (a.y2 - a.y1);
  const bArea = (b.x2 - b.x1) * (b.y2 - b.y1);
  return inter / (aArea + bArea - inter + 1e-6);
}

/**
 * Decode RetinaFace raw output tensors using anchor priors, then apply NMS.
 *
 * The ONNX model outputs raw anchor offsets, NOT pixel coordinates.
 * This function:
 *   1. Generates prior boxes (anchors) based on input image size
 *   2. Decodes bbox offsets → pixel coordinates using priors + variance
 *   3. Decodes landmark offsets → pixel coordinates
 *   4. Un-maps from letterbox space to original image space
 *   5. Applies NMS
 */
export function decodeRetinaFaceOutput(
  rawBboxOffsets: Float32Array,
  scores: Float32Array,
  rawLandmarkOffsets: Float32Array,
  numAnchors: number,
  inputH: number,
  inputW: number,
  opts: RetinaFaceDecodeOptions,
): FaceDetection[] {
  return decodeRetinaFaceOutputWithDebug(
    rawBboxOffsets,
    scores,
    rawLandmarkOffsets,
    numAnchors,
    inputH,
    inputW,
    opts,
  ).faces;
}

export function decodeRetinaFaceOutputWithDebug(
  rawBboxOffsets: Float32Array,
  scores: Float32Array,
  rawLandmarkOffsets: Float32Array,
  numAnchors: number,
  inputH: number,
  inputW: number,
  opts: RetinaFaceDecodeOptions,
): { faces: FaceDetection[]; debug: RetinaFaceDecodeDebug } {
  // Step 1: Generate prior boxes for this input size
  const priors = generatePriors(inputH, inputW);
  const debug: RetinaFaceDecodeDebug = {
    anchors: numAnchors,
    pre_nms_confidence_threshold: opts.confidenceThreshold,
    vis_confidence_threshold: Math.max(opts.confidenceThreshold, opts.visThreshold),
    min_face_size: opts.minFaceSize,
    pre_nms_candidates: 0,
    top_k_candidates: 0,
    decoded_boxes: 0,
    invalid_boxes: 0,
    nms_kept: 0,
    after_keep_top_k: 0,
    rejected_by_vis_confidence: 0,
    rejected_by_min_face_size: 0,
    output_faces: 0,
  };

  // Step 2: Decode anchor offsets → pixel coordinates in letterbox space
  const decodedBboxes = decodeBBoxes(rawBboxOffsets, priors, numAnchors, inputW, inputH);
  const decodedLandmarks = decodeLandmarks(rawLandmarkOffsets, priors, numAnchors, inputW, inputH);

  // Step 3: Initial confidence filter (low threshold, reference default 0.02)
  // Collect indices that pass initial threshold
  type RawDet = { index: number; score: number };
  const candidates: RawDet[] = [];
  for (let i = 0; i < numAnchors; i++) {
    if (scores[i]! > opts.confidenceThreshold) {
      candidates.push({ index: i, score: scores[i]! });
    }
  }
  debug.pre_nms_candidates = candidates.length;

  // Step 4: Sort by score descending, keep top_k before NMS
  candidates.sort((a, b) => b.score - a.score);
  const topKCandidates = candidates.slice(0, opts.topK);
  debug.top_k_candidates = topKCandidates.length;

  // Step 5: Un-map to original image coordinates and build detection objects
  type DetWithCorners = FaceDetection & { x1: number; y1: number; x2: number; y2: number };
  const dets: DetWithCorners[] = [];
  for (const { index: i, score } of topKCandidates) {
    const x1 = (decodedBboxes[i * 4]! - opts.padX) / opts.scale;
    const y1 = (decodedBboxes[i * 4 + 1]! - opts.padY) / opts.scale;
    const x2 = (decodedBboxes[i * 4 + 2]! - opts.padX) / opts.scale;
    const y2 = (decodedBboxes[i * 4 + 3]! - opts.padY) / opts.scale;

    // Validate: finite and valid box
    if (!isFinite(x1) || !isFinite(y1) || !isFinite(x2) || !isFinite(y2)) {
      debug.invalid_boxes++;
      continue;
    }
    if (x2 <= x1 || y2 <= y1) {
      debug.invalid_boxes++;
      continue;
    }

    const lm: Array<{ x: number; y: number }> = [];
    for (let j = 0; j < 5; j++) {
      const lx = (decodedLandmarks[i * 10 + j * 2]! - opts.padX) / opts.scale;
      const ly = (decodedLandmarks[i * 10 + j * 2 + 1]! - opts.padY) / opts.scale;
      if (!isFinite(lx) || !isFinite(ly)) { lm.length = 0; break; }
      lm.push({ x: lx, y: ly });
    }

    dets.push({
      bbox: { x: Math.max(0, x1), y: Math.max(0, y1), width: x2 - x1, height: y2 - y1 },
      confidence: score,
      landmarks: lm.length === 5 ? lm : undefined,
      x1, y1, x2, y2,
    });
  }
  debug.decoded_boxes = dets.length;

  // Step 6: NMS (reference: nms_threshold=0.4)
  const kept: DetWithCorners[] = [];
  for (const det of dets) {
    let suppressed = false;
    for (const k of kept) {
      if (iou(det, k) > opts.nmsThreshold) { suppressed = true; break; }
    }
    if (!suppressed) kept.push(det);
  }
  debug.nms_kept = kept.length;

  // Step 7: Keep top_k after NMS
  const afterNms = kept.slice(0, opts.keepTopK);
  debug.after_keep_top_k = afterNms.length;

  // Step 8: Apply vis_threshold + min_face_size (the reference final filter)
  const final: FaceDetection[] = [];
  for (const det of afterNms) {
    // Second confidence filter (vis_threshold, reference default 0.6)
    if (det.confidence < Math.max(opts.confidenceThreshold, opts.visThreshold)) {
      debug.rejected_by_vis_confidence++;
      continue;
    }
    // Minimum face size filter (reference default 20px)
    const faceW = det.x2 - det.x1;
    const faceH = det.y2 - det.y1;
    if (Math.min(faceW, faceH) < opts.minFaceSize) {
      debug.rejected_by_min_face_size++;
      continue;
    }

    final.push({
      bbox: det.bbox,
      confidence: det.confidence,
      landmarks: det.landmarks,
    });
  }
  debug.output_faces = final.length;

  return { faces: final, debug };
}

/**
 * RetinaFace detector: preprocesses frames and runs ONNX inference.
 * Supports batch inference (fixed batch=10, 320x320 input).
 */
export class RetinaFaceDetector {
  private modelManager: ModelManager;
  private decodeOpts: Omit<RetinaFaceDecodeOptions, "scale" | "padX" | "padY">;

  static readonly BATCH_SIZE = 10;
  // Match the reference ResNet50 setting (840x840) for best face recall.
  static readonly INPUT_SIZE = 840;

  constructor(modelManager: ModelManager, opts?: Partial<Omit<RetinaFaceDecodeOptions, "scale" | "padX" | "padY">>) {
    this.modelManager = modelManager;
    this.decodeOpts = {
      confidenceThreshold: opts?.confidenceThreshold ?? FACE_PRE_NMS_CONFIDENCE,
      visThreshold: opts?.visThreshold ?? FACE_VIS_CONFIDENCE,
      topK: opts?.topK ?? 5000,                                 // reference default
      keepTopK: opts?.keepTopK ?? 750,                           // reference default
      nmsThreshold: opts?.nmsThreshold ?? 0.4,                   // reference default
      minFaceSize: opts?.minFaceSize ?? DEFAULT_MIN_FACE_SIZE,
    };
  }

  /**
   * Preprocess a single frame for RetinaFace inference.
   *
   * CRITICAL: Must match the reference implementation's preprocessing exactly:
   *   - Resize preserving aspect ratio (NO letterbox padding)
   *   - BGR mean subtraction [104, 117, 123]
   *   - RGB→BGR channel swap
   *
   * the reference implementation uses cv2.resize(fx=ratio, fy=ratio) which produces
   * a non-square image (e.g., 1280×720 → 840×472). The ONNX model
   * accepts dynamic height/width dims since we export with fixed batch=1
   * but flexible H×W.
   *
   * Using letterbox (resizeAndPad to 840×840) causes bbox decode errors
   * because prior boxes are generated for a square grid but the actual
   * image content only occupies part of it.
   */
  private async preprocessFrame(frameBase64: string): Promise<{
    pixels: Float32Array;
    resizeRatio: number;
    actualH: number;
    actualW: number;
  }> {
    const sharp = await getSharp();
    const buf = Buffer.from(frameBase64, "base64");
    const meta = await sharp(buf).metadata();
    const origW = meta.width!;
    const origH = meta.height!;

    // reference resize logic: scale shortest side to IMAGE_SIZE,
    // but cap longest side at IMAGE_SIZE too
    const SZ = RetinaFaceDetector.INPUT_SIZE;
    const imSizeMin = Math.min(origH, origW);
    const imSizeMax = Math.max(origH, origW);
    let resizeRatio = SZ / imSizeMin;
    if (Math.round(resizeRatio * imSizeMax) > SZ) {
      resizeRatio = SZ / imSizeMax;
    }

    const newW = Math.round(origW * resizeRatio);
    const newH = Math.round(origH * resizeRatio);

    // Resize with aspect ratio preserved (no padding!)
    const rawBuf = await sharp(buf)
      .removeAlpha()
      .resize(newW, newH, { fit: "fill" })
      .raw()
      .toBuffer();
    const data = new Uint8Array(rawBuf);

    // BGR mean subtraction + RGB→BGR channel swap
    const size = newW * newH;
    const float32 = new Float32Array(3 * size);
    const bgrMean = [104, 117, 123];

    for (let i = 0; i < size; i++) {
      const r = data[i * 3]!;
      const g = data[i * 3 + 1]!;
      const b = data[i * 3 + 2]!;
      float32[0 * size + i] = b - bgrMean[0]!;
      float32[1 * size + i] = g - bgrMean[1]!;
      float32[2 * size + i] = r - bgrMean[2]!;
    }

    return { pixels: float32, resizeRatio, actualH: newH, actualW: newW };
  }

  /**
   * Detect faces in a single base64 JPEG frame.
   *
   * Uses aspect-ratio-preserving resize (NOT letterbox) to match the reference implementation.
   * The ONNX model must accept dynamic height/width dims (exported without fixed H×W).
   */
  async detect(frameBase64: string): Promise<FaceDetection[]> {
    return (await this.detectWithDebug(frameBase64)).faces;
  }

  async detectWithDebug(frameBase64: string): Promise<{ faces: FaceDetection[]; debug: RetinaFaceDecodeDebug }> {
    await this.modelManager.ensureLoaded("retinaface-resnet50");

    const { pixels, resizeRatio, actualH, actualW } = await this.preprocessFrame(frameBase64);
    const tensor = { data: pixels, dims: [1, 3, actualH, actualW] };

    const outputs = await this.modelManager.engine.run("retinaface-resnet50", { input: tensor });
    const bboxesTensor = outputs["bbox"] ?? outputs["bboxes"];
    const scoresTensor = outputs["cls"] ?? outputs["scores"];
    const landmarksTensor = outputs["landmark"] ?? outputs["landmarks"];
    if (!bboxesTensor || !scoresTensor || !landmarksTensor) {
      throw new Error("RetinaFace output missing tensors. Found: " + Object.keys(outputs).join(", "));
    }

    const N = bboxesTensor.dims[1]!;
    const clsData = scoresTensor.data as Float32Array;
    const faceScores = new Float32Array(N);
    for (let i = 0; i < N; i++) faceScores[i] = clsData[i * 2 + 1]!;

    // Decode with actual (non-square) image dimensions.
    // scale = resizeRatio (no padding), padX = padY = 0.
    return decodeRetinaFaceOutputWithDebug(
      bboxesTensor.data as Float32Array, faceScores,
      landmarksTensor.data as Float32Array, N,
      actualH, actualW,
      { ...this.decodeOpts, scale: resizeRatio, padX: 0, padY: 0 },
    );
  }

  /**
   * Batch face detection: processes each frame individually via detect().
   *
   * Cannot use true ONNX batching because aspect-ratio-preserving resize
   * produces different height/width dims per frame. Per-frame inference with
   * CoreML EP (batch=1) is already fast (~15ms/frame).
   */
  async detectBatch(framesBase64: string[]): Promise<FaceDetection[][]> {
    const results: FaceDetection[][] = [];
    for (const frame of framesBase64) {
      results.push(await this.detect(frame));
    }
    return results;
  }
}
