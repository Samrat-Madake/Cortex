import { writeStderr } from "@cortex/shared";
import type { PerceptionConfig } from "../config.js";
import { MODEL_MANIFEST } from "../models/model-manifest.js";
import { OnnxInferenceEngine } from "../models/onnx-engine.js";
import type {
  PipelineDeps,
  PipelineSelfCheckComponent,
  PipelineSelfCheckOptions,
  PipelineSelfCheckStatus,
} from "./types.js";

function statusRank(status: PipelineSelfCheckStatus): number {
  switch (status) {
    case "error": return 3;
    case "warn": return 2;
    case "disabled": return 1;
    case "ok": return 0;
  }
}

function isPlaceholderCredential(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return false;
  return [
    "sk-your-key-here",
    "your-vlm-api-key",
    "your-key",
    "your-api-key",
    "your-openai-api-key",
    "placeholder",
    "changeme",
    "change-me",
    "xxx",
  ].includes(normalized)
    || normalized.includes("your-key")
    || normalized.includes("placeholder")
    || normalized.includes("changeme");
}

function credentialComponent(config: PerceptionConfig): PipelineSelfCheckComponent {
  const missing = [
    !config.vlm_api_key ? "VLM_API_KEY" : "",
    config.vlm_provider === "openai" && !config.vlm_base_url ? "VLM_BASE_URL" : "",
  ].filter(Boolean);
  const placeholder = isPlaceholderCredential(config.vlm_api_key);
  return {
    name: "vlm",
    status: missing.length > 0 || placeholder ? "error" : "ok",
    required: true,
    detail: `provider=${config.vlm_provider} model=${config.vlm_model} lite=${config.vlm_model_lite} llm=${config.llm_model}${config.vlm_base_url ? ` base_url=${config.vlm_base_url}` : ""}${missing.length ? ` missing=${missing.join(",")}` : ""}${placeholder ? " placeholder_key=true" : ""}`,
  };
}

export function collectPipelineSelfCheckComponents(
  deps: PipelineDeps,
  extraComponents: PipelineSelfCheckComponent[] = [],
): PipelineSelfCheckComponent[] {
  const config = deps.selfCheck?.config;
  const components: PipelineSelfCheckComponent[] = [];
  if (!config) {
    components.push({ name: "pipeline_config", status: "warn", detail: "selfCheck snapshot missing" });
    return [...components, ...extraComponents];
  }

  components.push(credentialComponent(config));
  components.push({
    name: "working_memory",
    status: "ok",
    detail: `event_timeout_sec=${config.working_memory_event_timeout_sec} max_event_segments=${config.working_memory_max_event_segments}`,
  });
  components.push({ name: "media_uploader", status: "ok", detail: "configured" });

  const requiredLevel = config.required_level ?? 0;

  if (config.stubs_only) {
    components.push({
      name: "local_models",
      status: requiredLevel > 0 ? "error" : "disabled",
      required: requiredLevel > 0 ? true : undefined,
      detail: `stubs_only=true; ONNX detection/ReID disabled; required_level=${requiredLevel}`,
    });
  } else {
    const runtime = OnnxInferenceEngine.getRuntime();
    const loadedEps = deps.modelManager?.engine.getLoadedModelExecutionProviders() ?? {};
    const cpuLoaded = Object.entries(loadedEps).filter(([, ep]) => ep === "cpu").map(([id]) => id);
    components.push({
      name: "onnx_runtime",
      status: runtime.primaryEp === "cpu" || cpuLoaded.length > 0 ? "warn" : "ok",
      detail: `variant=${runtime.variant} primary_ep=${runtime.primaryEp}${cpuLoaded.length ? ` cpu_models=${cpuLoaded.join(",")}` : ""}`,
    });

    const maxLevel = deps.router?.getMaxLevel() ?? 0;
    const belowRequiredLevel = requiredLevel > 0 && maxLevel < requiredLevel;
    components.push({
      name: "local_model_capabilities",
      status: belowRequiredLevel ? "error" : maxLevel >= 1 ? "ok" : "warn",
      required: belowRequiredLevel ? true : undefined,
      detail: `max_level=${maxLevel} required_level=${requiredLevel} capabilities=${(deps.router?.getAvailableCapabilities() ?? []).join(",") || "none"} models_dir=${config.models_dir ?? "default"}${maxLevel >= requiredLevel && maxLevel >= 1 ? "" : " install native runtime with: cortex enable-level1"}`,
    });

    for (const provider of deps.router?.getProviderStatuses() ?? []) {
      const modelId = provider.modelId;
      const def = modelId ? MODEL_MANIFEST[modelId] : undefined;
      const providerRequired = !!def && def.min_level > 0 && def.min_level <= requiredLevel;
      const ep = modelId ? loadedEps[modelId] : undefined;
      components.push({
        name: `model:${provider.name}`,
        status: provider.ready ? "ok" : providerRequired ? "error" : "warn",
        required: providerRequired || undefined,
        detail: `type=${provider.type} runtime=${provider.runtime}${modelId ? ` model=${modelId}` : ""}${def ? ` file=${def.filename}` : ""}${ep ? ` ep=${ep}` : ""}${provider.ready ? "" : " ready=false"}`,
      });
    }
  }

  components.push({
    name: "stt",
    status: deps.precomputedStt
      ? "ok"
      : !config.stt_provider ? "disabled" : (deps.sttAnalyzer?.isAvailable || deps.elevenLabsStt) ? "ok" : "warn",
    detail: deps.precomputedStt
      ? "provider=precomputed"
      : !config.stt_provider
        ? "STT_PROVIDER not set"
        : deps.elevenLabsStt
          ? `provider=elevenlabs model=${config.elevenlabs_model_id} granularity=word diarization=true`
          : `provider=moonshine model_dir=${config.stt_model_dir || `${config.models_dir ?? ""}/sherpa-onnx-moonshine-tiny-en-int8`} available=${!!deps.sttAnalyzer?.isAvailable}`,
  });
  components.push({
    name: "narrative_memory",
    status: deps.narrativeMemory ? "ok" : "disabled",
    detail: deps.narrativeMemory ? "wired" : "not wired for this mode",
  });

  return [...components, ...extraComponents];
}

export function formatPipelineSelfCheckReport(deps: PipelineDeps, options: PipelineSelfCheckOptions = {}): string {
  const components = collectPipelineSelfCheckComponents(deps, options.components);
  const worst = components.reduce<PipelineSelfCheckStatus>((acc, c) => (statusRank(c.status) > statusRank(acc) ? c.status : acc), "ok");
  const fatal = components.filter((c) => c.required && c.status === "error");
  const abnormal = components.filter((c) => c.status === "warn" || c.status === "error");
  const header = [
    "========== Cortex Pipeline Self-Check ==========",
    `mode=${options.mode ?? "unknown"} label=${options.label ?? "pipeline"} status=${worst.toUpperCase()} abnormal=${abnormal.length} fatal=${fatal.length}`,
  ];
  const body = components.map((c) => {
    const required = c.required ? " required=true" : "";
    return `[${c.status.toUpperCase()}] ${c.name}:${required} ${c.detail}`;
  });
  return [...header, ...body, "==================================================="].join("\n");
}

export function logPipelineSelfCheck(deps: PipelineDeps, options: PipelineSelfCheckOptions = {}): void {
  const report = formatPipelineSelfCheckReport(deps, options);
  const logger = options.logger ?? ((message: string) => writeStderr(message));
  logger(report);
  if (options.throwOnFatal) {
    const fatal = collectPipelineSelfCheckComponents(deps, options.components)
      .filter((c) => c.required && c.status === "error");
    if (fatal.length > 0) {
      throw new Error(`Pipeline self-check failed: ${fatal.map((c) => c.name).join(", ")}`);
    }
  }
}
