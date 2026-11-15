// packages/percept/src/models/model-manifest.ts
import { join } from "node:path";
import { resolveCortexHome, canonicalize } from "@cortex/shared";

/** Supported model identifiers. */
export type ModelId =
  | "yolo26m"
  | "retinaface-resnet50"
  | "arcface-mbf"
  | "clip-reid-vitb"
  | "rtmpose-s";

/** Capability that a model provides. */
export type ModelCapability = "general-detection" | "face-detection" | "face-reid" | "body-reid" | "pose-estimation";

/** Level requirements: which capabilities are needed for each perception level. */
export const LEVEL_REQUIREMENTS: Record<number, ModelCapability[]> = {
  0: [], // VLM only
  1: ["general-detection", "face-detection", "face-reid"], // + frame detection + RetinaFace + face ReID
};

// Future local-model tiers should add explicit capabilities here.
// body-reid is an optional experimental capability, not required for any level.

export interface ModelDefinition {
  id: ModelId;
  name: string;
  filename: string;
  capability: ModelCapability;
  /** Required perception level (model is needed at this level and above). 0 = optional/experimental. */
  min_level: 0 | 1 | 2;
  /** Input tensor shape [batch, channels, height, width]. */
  input_shape: [number, number, number, number];
  /** Human-readable description for install CLI. */
  description: string;
  /** Approximate file size in MB for install CLI display. */
  size_mb: number;
  /** Download URL (set when hosting is configured). */
  download_url?: string;
  /** SHA256 checksum for validation. */
  sha256?: string;
}

export const MODEL_MANIFEST: Record<ModelId, ModelDefinition> = {
  "yolo26m": {
    id: "yolo26m",
    name: "YOLO26m",
    filename: "yolo26m.onnx",
    capability: "general-detection",
    min_level: 1,
    input_shape: [1, 3, 640, 640],
    description: "General object detector (COCO 80 classes, YOLO26 Medium)",
    size_mb: 78,
  },
  "retinaface-resnet50": {
    id: "retinaface-resnet50",
    name: "RetinaFace ResNet50",
    filename: "retinaface-resnet50.onnx",
    capability: "face-detection",
    min_level: 1,
    input_shape: [1, 3, 840, 840],
    description: "Face detector with landmarks (verify upstream model license)",
    size_mb: 110,
  },
  "arcface-mbf": {
    id: "arcface-mbf",
    name: "ArcFace MobileFaceNet W600K",
    filename: "w600k_mbf.onnx",
    capability: "face-reid",
    min_level: 1,
    input_shape: [1, 3, 112, 112],
    description: "Face ReID (512d, verify upstream model license, dynamic batch)",
    size_mb: 25,
  },
  "clip-reid-vitb": {
    id: "clip-reid-vitb",
    name: "CLIP-ReID ViT-B",
    filename: "clip-reid-vitb.onnx",
    capability: "body-reid",
    min_level: 0, // Optional experimental — not required for any level
    input_shape: [8, 3, 256, 128],
    description: "Body ReID (768d embedding)",
    size_mb: 350,
  },
  "rtmpose-s": {
    id: "rtmpose-s",
    name: "RTMPose-s",
    filename: "rtmpose-s.onnx",
    capability: "pose-estimation",
    min_level: 0,
    input_shape: [1, 3, 256, 192],
    description: "Body pose estimation (17 COCO keypoints, SimCC)",
    size_mb: 21,
  },
};

/** Default model storage directory. */
export function getModelsDir(): string {
  const configured = process.env.CORTEX_MODELS_DIR;
  if (configured) return canonicalize(configured);
  return join(resolveCortexHome(), "models");
}
