import { writeStderr } from "@cortex/shared";
import { join } from "node:path";
import { ElevenLabsStt } from "../analyzers/elevenlabs-stt.js";
import { SttAnalyzer } from "../analyzers/stt-analyzer.js";
import { VlmAnalyzer } from "../analyzers/vlm-analyzer.js";
import type { PerceptionConfig } from "../config.js";
import { MediaUploader, type MediaSaver } from "../media-uploader.js";
import { ModelManager } from "../models/model-manager.js";
import { createBuiltinProviders } from "../providers/builtin/index.js";
import { DEFAULT_PROVIDER_CONFIG } from "../providers/provider-config.js";
import { ModelRouter } from "../providers/model-router.js";
import { StrategyManager } from "../strategy-manager.js";
import { WorkingMemoryManager } from "../working-memory.js";
import { createPipelineRuntimeState } from "./runtime.js";
import type { PipelineDeps } from "./types.js";

/**
 * Creates the pipeline dependencies from a resolved PerceptionConfig.
 * Use this factory in the OpenClaw plugin entry to wire everything up.
 *
 * @param mediaSaver - Storage backend for media files (e.g. PipelineStore)
 */
export async function createPipelineDeps(config: PerceptionConfig, mediaSaver: MediaSaver): Promise<PipelineDeps> {
  let vlmAnalyzer: VlmAnalyzer;

  const promptContext = {
    sceneDescription: config.scene_description,
    focusTargets: config.focus_targets,
    securityRules: config.security_rules,
  };
  const vlmReliability = {
    requestTimeoutMs: config.vlm_request_timeout_ms,
    maxRetries: config.vlm_max_retries,
    retryBaseDelayMs: config.vlm_retry_base_delay_ms,
    retryMaxDelayMs: config.vlm_retry_max_delay_ms,
  };

  if (config.vlm_provider === "openai") {
    vlmAnalyzer = new VlmAnalyzer({
      provider: "openai",
      apiKey: config.vlm_api_key,
      baseUrl: config.vlm_base_url ?? "https://api.openai.com/v1",
      textModel: config.llm_model,
      promptContext,
      ...vlmReliability,
    });
  } else {
    vlmAnalyzer = new VlmAnalyzer({
      provider: "gemini",
      apiKey: config.vlm_api_key,
      textModel: config.llm_model,
      promptContext,
      ...vlmReliability,
    });
  }

  // Create ModelRouter if not in stubs-only mode
  let router: ModelRouter | undefined;
  let modelManager: ModelManager | undefined;
  if (!config.stubs_only) {
    modelManager = new ModelManager(config.models_dir);
    const builtinProviders = createBuiltinProviders(modelManager, { includeBodyReId: config.body_reid_enabled });
    router = new ModelRouter();
    for (const p of builtinProviders) router.register(p);
    for (const [cap, names] of Object.entries(DEFAULT_PROVIDER_CONFIG.routing)) {
      if (!config.body_reid_enabled && (cap === "body-reid" || cap === "pose-estimation")) continue;
      router.setRouting(cap, names);
    }
    await router.initializeAll();
  }

  // STT provider routing: "elevenlabs" (cloud + diarization), "moonshine" (local), or "" (disabled)
  let sttAnalyzer: SttAnalyzer | undefined;
  let elevenLabsStt: ElevenLabsStt | undefined;

  if (config.stt_provider === "elevenlabs" && config.elevenlabs_api_key) {
    elevenLabsStt = new ElevenLabsStt({
      apiKey: config.elevenlabs_api_key,
      modelId: config.elevenlabs_model_id,
      languageCode: config.elevenlabs_language_code,
    });
  } else if (config.stt_provider === "elevenlabs" && !config.elevenlabs_api_key) {
    writeStderr("[STT WARNING] STT_PROVIDER=elevenlabs but ELEVENLABS_API_KEY is not set. STT disabled.");
  } else if (config.stt_provider === "moonshine") {
    const modelDir = config.stt_model_dir || join(config.models_dir ?? "", "sherpa-onnx-moonshine-tiny-en-int8");
    const stt = new SttAnalyzer({ modelDir, numThreads: config.stt_num_threads });
    const ok = await stt.init();
    if (!ok) {
      writeStderr(`[MODEL WARNING] STT analyzer unavailable; STT disabled. model_dir=${modelDir}`);
    } else {
      sttAnalyzer = stt;
    }
  }
  // else: stt_provider="" -> STT disabled, both undefined

  return {
    workingMemory: new WorkingMemoryManager({
      event_timeout_sec: config.working_memory_event_timeout_sec,
      max_event_segments: config.working_memory_max_event_segments,
    }),
    strategyManager: new StrategyManager({
      stubsOnly: config.stubs_only,
      modelRouter: router,
      modelLite: config.vlm_model_lite,
      modelFull: config.vlm_model,
    }),
    vlmAnalyzer,
    router,
    modelManager,
    bodyReIdEnabled: config.body_reid_enabled,
    vlmFrameResize: {
      enabled: config.vlm_frame_resize_enabled,
      shortEdge: config.vlm_frame_resize_short_edge,
      jpegQuality: config.vlm_frame_resize_jpeg_quality,
    },
    mediaUploader: new MediaUploader(mediaSaver),
    runtimeMode: config.runtime_mode,
    animatedSegmentPreview: config.animated_segment_previews,
    memoryHistoryMode: "observer",
    sttAnalyzer,
    elevenLabsStt,
    selfCheck: {
      config,
      createdAt: new Date().toISOString(),
    },
    _runtimeState: createPipelineRuntimeState(),
  };
}
