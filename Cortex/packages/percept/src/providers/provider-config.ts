// packages/percept/src/providers/provider-config.ts
import { z } from "zod";

/** Schema for a single provider declaration. */
const ProviderEntrySchema = z.object({
  /** Model type determines output schema. */
  type: z.enum(["detector", "reid", "classifier", "pose", "custom"]),
  /** Runtime backend. */
  runtime: z.enum(["onnx-builtin", "python", "remote"]),
  /** For onnx-builtin: model ID from model-manifest. */
  modelId: z.string().optional(),
  /** For python/remote: HTTP endpoint URL. */
  endpoint: z.string().optional(),
  /** For remote: user's ONNX model path (loaded via builtin engine). */
  modelPath: z.string().optional(),
  /** Optional confidence threshold override. */
  confidenceThreshold: z.number().min(0).max(1).optional(),
});

/** Schema for Python extension layer configuration. */
const PythonConfigSchema = z.object({
  enabled: z.boolean().default(false),
  endpoint: z.string().default("http://127.0.0.1:8220"),
  autoStart: z.boolean().default(true),
  sourceDir: z.string().optional(),
});

/** Full provider config schema. */
export const ProviderConfigSchema = z.object({
  /** Named provider declarations. */
  providers: z.record(z.string(), ProviderEntrySchema).default({}),
  /** Routing: maps capability → ordered list of provider names (first available wins). */
  routing: z.record(z.string(), z.array(z.string())).default({}),
  /** Python extension layer settings. */
  python: PythonConfigSchema.default({}),
});

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type ProviderEntry = z.infer<typeof ProviderEntrySchema>;

/** Default config: all builtin ONNX providers, auto-detected from installed models. */
export const DEFAULT_PROVIDER_CONFIG: ProviderConfig = {
  providers: {
    "yolo26m-builtin": { type: "detector", runtime: "onnx-builtin", modelId: "yolo26m" },
    "retinaface-builtin": { type: "detector", runtime: "onnx-builtin", modelId: "retinaface-resnet50" },
    "adaface-builtin": { type: "reid", runtime: "onnx-builtin", modelId: "arcface-mbf" },
    "clip-reid-builtin": { type: "reid", runtime: "onnx-builtin", modelId: "clip-reid-vitb" },
    "rtmpose-builtin": { type: "pose", runtime: "onnx-builtin", modelId: "rtmpose-s" },
  },
  routing: {
    "general-detection": ["yolo26m-builtin"],
    "face-detection": ["retinaface-builtin"],
    "face-reid": ["adaface-builtin"],
    "body-reid": ["clip-reid-builtin"],
    "pose-estimation": ["rtmpose-builtin"],
  },
  python: { enabled: false, endpoint: "http://127.0.0.1:8220", autoStart: true },
};
