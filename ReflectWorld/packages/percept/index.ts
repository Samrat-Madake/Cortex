// packages/percept/index.ts
import type { OpenClawPluginApi } from "@reflectworld/shared";
import { PerceptionToolSchema } from "./src/schema.js";
import { executeToolAction } from "./src/tool.js";
import { createPipelineDeps, logPipelineSelfCheck } from "./src/pipeline.js";
import { resolvePerceptionConfig } from "./src/config.js";

// ── Public API ──
export { analyze, createPipelineDeps, parseSemanticContextSections, collectPipelineSelfCheckComponents, formatPipelineSelfCheckReport, logPipelineSelfCheck, clearCameraRuntimeState } from "./src/pipeline.js";
export { executeToolAction } from "./src/tool.js";
export type { PipelineDeps, PipelineMemory, PostProcessor, VlmMeta, CaptureHint, SemanticContextSections, PipelineSelfCheckComponent, PipelineSelfCheckOptions, PipelineSelfCheckStatus, PipelineRuntimeState } from "./src/pipeline.js";
export { resolveNotifications } from "./src/notification-resolver.js";
export type { Notification, NotifyPolicy, NotifyOptions } from "./src/notification-resolver.js";
export { WorkingMemoryManager } from "./src/working-memory.js";
export { StrategyManager } from "./src/strategy-manager.js";
export { VlmAnalyzer } from "./src/analyzers/vlm-analyzer.js";
export type { ReasoningEffort } from "./src/analyzers/vlm-analyzer.js";
export { DEFAULT_VLM_CALL_PROFILE, GPT_5_MINI_VLM_CALL_PROFILE, applyVlmCallProfile, resolveVlmCallProfile } from "./src/vlm-call-profiles.js";
export type { VlmCallMode, VlmCallProfile, VlmCallStage, VlmModelProfile } from "./src/vlm-call-profiles.js";
export { MediaUploader } from "./src/media-uploader.js";
export type { MediaSaver } from "./src/media-uploader.js";
export { buildAnimatedSegmentPreviewBuffer } from "./src/pipeline/media.js";
export { resolvePerceptionConfig, PerceptionConfigSchema } from "./src/config.js";
export type { PerceptionConfig } from "./src/config.js";
export type {
  VlmOutput,
  SttOutput,
  AnalyzerResult,
  StrategyConfig,
  WorkingMemoryState,
  EntityContext,
} from "./src/types.js";
export { SemanticContextManager, serializeSemanticContext, buildSummarizationPrompt } from "./src/semantic-context.js";
export type {
  SemanticContextData,
  SemanticContextEntityObservation,
  SemanticContextIdentityCue,
  SemanticContextMetadata,
  SemanticContextManagerConfig,
  SemanticContextWriter,
  SummarizationResult,
} from "./src/semantic-context.js";
export { SttAnalyzer } from "./src/analyzers/stt-analyzer.js";
export type { SttAnalyzerOptions, SttResult } from "./src/analyzers/stt-analyzer.js";
export { ElevenLabsStt, wrapPcmAsWav } from "./src/analyzers/elevenlabs-stt.js";
export type { ElevenLabsSttOptions } from "./src/analyzers/elevenlabs-stt.js";
export { setupSttModels, isMoonshineModelPresent, verifyOnnxLoadable } from "./src/binary-installer.js";
export type { LocalModelResults } from "./src/analyzers/vlm-analyzer.js";
export { FrameAnalyzer } from "./src/frame-analyzer.js";
export type { FrameAnalysisResult, FrameDetection, FrameAnalyzerDeps } from "./src/frame-analyzer.js";
export { NarrativeMemory } from "./src/narrative-memory.js";
export type { NarrativeMemoryConfig, EpisodicSchemaWriter } from "./src/narrative-memory.js";
export type { EventCloseSummary, NarrativeCallbacks } from "./src/types.js";

export default {
  id: "reflectworld-percept",
  name: "ReflectWorld Perception",
  description:
    "Visual perception pipeline: VLM analysis, working memory event tracking, " +
    "local media storage, code-driven notifications.",

  register(api: OpenClawPluginApi) {
    const config = resolvePerceptionConfig(api.pluginConfig);
    const noopSaver = { saveMedia: () => "" };
    // Lazy init: createPipelineDeps is now async (router.initializeAll)
    let depsPromise: Promise<import("./src/pipeline.js").PipelineDeps> | undefined;
    const getDeps = () => {
      if (!depsPromise) {
        depsPromise = createPipelineDeps(config, noopSaver).then((deps) => {
          logPipelineSelfCheck(deps, {
            mode: "percept-plugin",
            label: "reflectworld_perception",
            throwOnFatal: true,
            logger: (message) => api.logger.info(message),
          });
          return deps;
        });
      }
      return depsPromise;
    };

    api.registerTool({
      name: "reflectworld_perception",
      description: `Perception configuration and analysis tool.

Primary action:
- configure: Set scene context and analysis preferences. Use when the user describes their scene, what to watch for, or security rules. Params: config (required).
  Examples:
  - User says "this camera watches the front door" → config.scene_description = "Front door camera overlooking the porch"
  - User says "watch for packages and pets" → config.focus_targets = "packages, pets"
  - User says "nobody should be here after 10pm" → config.security_rules = "No one should be on the property after 10pm"

Normally automatic (but available on explicit request):
- analyze: Run perception on a Segment. Automatically called by Eye pipeline — only use if the user explicitly asks to analyze a specific segment.
- get_status: Debug info for a camera's perception state. Params: camera_id. Returns: active event, segment count, strategy level.`,
      parameters: PerceptionToolSchema as unknown as Record<string, unknown>,
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        const deps = await getDeps();
        return executeToolAction(params, deps);
      },
    });
  },
};
