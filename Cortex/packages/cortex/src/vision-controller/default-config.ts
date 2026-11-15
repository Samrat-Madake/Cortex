import type { VCLegacyConfig } from "../vc-types/types.js";
import type { VisionControllerConfig } from "./types.js";

const BENCHMARK_RULES: VisionControllerConfig["rules"] = [
  {
    name: "person_present",
    trigger: { type: "class_detected", class: "person" },
    action: { fps: 1 },
    cooldown_ms: 5000,
    hold_ms: 30_000,
  },
  {
    name: "moving_object_observe",
    trigger: {
      type: "all_of",
      conditions: [
        {
          type: "any_of",
          conditions: [
            { type: "class_detected", class: "vehicle" },
            { type: "class_detected", class: "car" },
            { type: "class_detected", class: "truck" },
            { type: "class_detected", class: "bus" },
            { type: "class_detected", class: "animal" },
            { type: "class_detected", class: "dog" },
            { type: "class_detected", class: "cat" },
            { type: "class_detected", class: "bird" },
          ],
        },
        { type: "motion_sustained_ms", duration: 1000 },
      ],
    },
    action: { fps: 1 },
    cooldown_ms: 5000,
    hold_ms: 30_000,
  },
];

const BENCHMARK_SEGMENT_POLICY: NonNullable<VisionControllerConfig["segment_policy"]> = {
  consultation_triggers: [
    { type: "security_risk" },
  ],
  consultation_cooldown_seconds: 60,
  consultation_event_budget: 5,
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function createBenchmarkVisionControllerConfig(): VisionControllerConfig {
  return {
    enabled: true,
    baseline: { fps: 1 },
    rules: clone(BENCHMARK_RULES),
    segment_policy: clone(BENCHMARK_SEGMENT_POLICY),
  };
}

export function createBenchmarkVisionControllerLegacyConfig(): VCLegacyConfig {
  const config = createBenchmarkVisionControllerConfig();
  return {
    enabled: config.enabled,
    baseline: config.baseline,
    auto_rules: config.rules,
    segment_policy: config.segment_policy,
  };
}

export function mergeWithBenchmarkVisionControllerDefaults(
  raw: Partial<VCLegacyConfig> | undefined,
): VCLegacyConfig {
  const defaults = createBenchmarkVisionControllerLegacyConfig();
  if (!raw) return defaults;
  return {
    enabled: raw.enabled ?? defaults.enabled,
    baseline: { ...defaults.baseline, ...(raw.baseline ?? {}) },
    auto_rules: raw.auto_rules ?? defaults.auto_rules,
    segment_policy: raw.segment_policy ?? defaults.segment_policy,
  };
}
