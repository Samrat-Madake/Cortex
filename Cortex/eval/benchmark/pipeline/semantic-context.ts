import {
  buildSummarizationPrompt,
  SemanticContextManager,
  type PipelineDeps,
  type SemanticContextWriter,
  type SummarizationResult,
} from "@cortex/percept";
import type { LlmCallContext, LlmCallRecord, PerceptionResult } from "@cortex/shared";

interface SemanticContextStore {
  getSegmentCount(cameraId: string): number;
  saveLlmCall(call: LlmCallRecord): void;
}

export interface BenchmarkSemanticContextOptions {
  pipelineDeps: PipelineDeps;
  memClient: SemanticContextWriter;
  store: SemanticContextStore;
  userId: string;
  model: string;
  promptVersion?: string;
  llmContext?: LlmCallContext;
  logPrefix?: string;
}

export function wireBenchmarkSemanticContext(options: BenchmarkSemanticContextOptions): SemanticContextManager {
  const {
    pipelineDeps,
    memClient,
    store,
    userId,
    model,
    promptVersion,
    llmContext,
    logPrefix = "benchmark",
  } = options;

  const manager = new SemanticContextManager({
    memClient,
    userId,
    getSegmentCount: (cameraId) => store.getSegmentCount(cameraId),
    onLlmUpdate: async (cameraId, currentProfile, observations): Promise<SummarizationResult> => {
      const prompt = buildSummarizationPrompt(currentProfile, observations);
      try {
        const jsonText = await pipelineDeps.vlmAnalyzer.completeText(prompt, {
          responseFormat: "json",
          model,
          stage: "semantic_context.profile_summary",
          reasoningEffort: "low",
          promptVersion,
          llmContext: { ...llmContext, camera_id: cameraId },
        });
        const result = JSON.parse(jsonText) as SummarizationResult;
        const hasProfileUpdate = [
          result.scene_description,
          result.known_entities,
          result.daily_routine,
          result.anomaly_baseline,
        ].some((value) => typeof value === "string" && value.trim().length > 0);
        if (result.no_update === true || hasProfileUpdate) return result;
        throw new Error("invalid SemanticContext LLM result: missing no_update=true or profile update fields");
      } catch (err) {
        console.error(`[${logPrefix}][semantic-context] LLM update failed: ${err instanceof Error ? err.message : err}`);
        throw err;
      }
    },
  });

  pipelineDeps.semanticContext = {
    load: manager.load.bind(manager),
    onSegmentProcessed: manager.onSegmentProcessed.bind(manager),
    clearBuffer: manager.clearBuffer.bind(manager),
    setUserNotes: manager.setUserNotes.bind(manager),
    initProfile: manager.initProfile.bind(manager),
    updateDirectives: manager.updateDirectives.bind(manager),
  };
  pipelineDeps.getSegmentCount = (cameraId) => store.getSegmentCount(cameraId);

  pipelineDeps.vlmAnalyzer.setLlmCallRecorder((call) => {
    try { store.saveLlmCall(call); } catch { /* best-effort */ }
  });

  return manager;
}

export function recordBenchmarkSemanticContextObservation(
  manager: SemanticContextManager,
  result: PerceptionResult,
): Promise<void> {
  const entities = (result.perception_memory.entities ?? []).map((entity) => ({
    entity_id: entity.entity_id,
    track_id: entity.track_id,
    type: entity.type,
    appearance: entity.appearance,
    is_new_entity: entity.is_new_entity,
  }));
  const identityCues = [
    ...(result.perception_memory.entities ?? [])
      .filter((entity) => entity.name)
      .map((entity) => ({
        name: entity.name!,
        entity_id: entity.entity_id,
        segment_id: result.segment_id,
        track_id: entity.track_id,
        evidence: entity.identity_evidence,
        source: "target_identity" as const,
      })),
  ];
  return manager.onSegmentProcessed(
    result.camera_id,
    result.perception_memory.summary,
    entities,
    identityCues,
  );
}
