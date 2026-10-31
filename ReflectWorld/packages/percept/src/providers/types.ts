// packages/percept/src/providers/types.ts

/** Supported model types. Each type has a typed output schema. */
export type ModelType = "detector" | "reid" | "classifier" | "pose" | "custom";

/** Runtime backend that executes the model. */
export type ProviderRuntime = "onnx-builtin" | "python" | "remote";

/** Unified input for all providers. Raw image buffer + dimensions. */
export interface InferInput {
  /** Raw image data (JPEG or RGB buffer). */
  imageBuffer: Buffer;
  /** Image width in pixels. Optional for JPEG buffers (provider decodes internally). */
  width?: number;
  /** Image height in pixels. Optional for JPEG buffers (provider decodes internally). */
  height?: number;
  /** Optional model-specific parameters. */
  options?: Record<string, unknown>;
}

// ── Output schemas per model type ──

export interface DetectorBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  confidence: number;
  class_id: number;
  class_name?: string;
  landmarks?: Array<{ x: number; y: number }>;
}

export interface DetectorOutput {
  boxes: DetectorBox[];
  /** Optional provider diagnostics for archive/debug. Does not affect model output semantics. */
  debug?: Record<string, unknown>;
}

export interface ReidOutput {
  embedding: number[];
  embedding_dim: number;
}

export interface ClassifierOutput {
  class_id: number;
  class_name?: string;
  confidence: number;
}

export interface PoseOutput {
  keypoints: Array<{ x: number; y: number; confidence: number; name?: string }>;
}

export type CustomOutput = Record<string, unknown>;

/** Union of all typed outputs. */
export type InferOutput = DetectorOutput | ReidOutput | ClassifierOutput | PoseOutput | CustomOutput;

// ── Provider interfaces ──

/** Base interface shared by all providers. */
export interface ModelProvider {
  /** Unique name for this provider instance (e.g. "yolo26m-builtin"). */
  readonly name: string;
  /** Model type determines the output schema. */
  readonly type: ModelType;
  /** Runtime backend. */
  readonly runtime: ProviderRuntime;
  /** Load model / establish connection. Idempotent. */
  initialize(): Promise<void>;
  /** Release resources. */
  dispose(): Promise<void>;
  /** Whether the provider is initialized and ready for inference. */
  isReady(): boolean;
}

/** Typed provider for object detection models. */
export interface DetectorProvider extends ModelProvider {
  readonly type: "detector";
  /** Run detection on a single image. Returns bounding boxes. */
  detect(input: InferInput): Promise<DetectorOutput>;
}

/** Typed provider for ReID / embedding extraction models. */
export interface ReidProvider extends ModelProvider {
  readonly type: "reid";
  /** Extract embedding from a single image crop. */
  extractEmbedding(input: InferInput): Promise<ReidOutput>;
}

/** Typed provider for classifiers (future). */
export interface ClassifierProvider extends ModelProvider {
  readonly type: "classifier";
  classify(input: InferInput): Promise<ClassifierOutput>;
}

/** Typed provider for pose estimation (future). */
export interface PoseProvider extends ModelProvider {
  readonly type: "pose";
  estimatePose(input: InferInput): Promise<PoseOutput>;
}

/** Typed provider for custom models. */
export interface CustomProvider extends ModelProvider {
  readonly type: "custom";
  infer(input: InferInput): Promise<CustomOutput>;
}

/** Union of all typed providers. */
export type AnyProvider = DetectorProvider | ReidProvider | ClassifierProvider | PoseProvider | CustomProvider;
