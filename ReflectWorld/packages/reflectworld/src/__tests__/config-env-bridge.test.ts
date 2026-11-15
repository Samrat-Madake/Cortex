import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeSecretInput } from "@cortex/shared";
import { bridgePluginConfigToEnv } from "../config-env-bridge.js";

describe("normalizeSecretInput", () => {
  it("returns plain string as-is", () => {
    expect(normalizeSecretInput("sk-plain")).toBe("sk-plain");
  });

  it("resolves env-source SecretRef via process.env", () => {
    process.env.__TEST_SECRET = "resolved-val";
    expect(normalizeSecretInput({ source: "env", provider: "default", id: "__TEST_SECRET" })).toBe("resolved-val");
    delete process.env.__TEST_SECRET;
  });

  it("returns undefined for file/exec source", () => {
    const warn = vi.fn();
    expect(normalizeSecretInput({ source: "file", provider: "default", id: "/secret" }, "cortex", warn)).toBeUndefined();
    expect(normalizeSecretInput({ source: "exec", provider: "default", id: "cmd" }, "cortex", warn)).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("returns undefined for empty/missing", () => {
    expect(normalizeSecretInput(undefined)).toBeUndefined();
    expect(normalizeSecretInput("")).toBeUndefined();
  });
});

describe("bridgePluginConfigToEnv", () => {
  beforeEach(() => {
    for (const key of [
      "VLM_API_KEY",
      "VLM_BASE_URL",
      "VLM_MODEL",
      "VLM_MODEL_LITE",
      "LLM_MODEL",
      "VLM_REQUEST_TIMEOUT_MS",
      "VLM_MAX_RETRIES",
      "VLM_RETRY_BASE_DELAY_MS",
      "VLM_RETRY_MAX_DELAY_MS",
      "CORTEX_PERCEPTION_SOURCE_CONCURRENCY",
      "CORTEX_PERCEPTION_MAX_QUEUED_PER_SOURCE",
      "CORTEX_PERCEPTION_LIVE_BACKLOG_SKIP_AFTER_MS",
      "CORTEX_LOCAL_FILE_PACING",
      "CORTEX_PERCEPTION_RUNTIME_MODE",
      "CORTEX_PERCEPTION_REQUIRED_LEVEL",
      "WORKING_MEMORY_EVENT_TIMEOUT_SEC",
      "WORKING_MEMORY_MAX_EVENT_SEGMENTS",
      "STUBS_ONLY",
      "CORTEX_MODELS_DIR",
      "SCENE_DESCRIPTION",
      "EMBEDDER_MODEL",
      "EMBEDDER_API_KEY",
      "EMBEDDING_DIMS",
      "STT_PROVIDER",
      "STT_MODEL_DIR",
      "STT_NUM_THREADS",
      "ELEVENLABS_API_KEY",
      "ELEVENLABS_MODEL_ID",
      "ELEVENLABS_LANGUAGE_CODE",
      "COLLECTION_PREFIX",
      "CORTEX_ENDPOINT",
      "FOCUS_TARGETS",
      "SECURITY_RULES",
      "CORTEX_PROFILING_ENABLED",
    ]) {
      delete process.env[key];
    }
  });

  it("maps perception provider fields to env", () => {
    bridgePluginConfigToEnv({
      perception: {
        vlm_api_key: "k",
        vlm_base_url: "u",
        vlm_model: "m",
        vlm_model_lite: "ml",
        llm_model: "lm",
        vlm_request_timeout_ms: 60_000,
        vlm_max_retries: 4,
        vlm_retry_base_delay_ms: 700,
        vlm_retry_max_delay_ms: 5_000,
        source_concurrency: 2,
        max_queued_per_source: 9,
        live_backlog_skip_after_ms: 180_000,
        local_file_pacing: "realtime",
        runtime_mode: "live_latency",
        working_memory_event_timeout_sec: 30,
        working_memory_max_event_segments: 12,
        stubs_only: false,
        required_level: 1,
        models_dir: "/tmp/models",
        scene_description: "front lobby",
        stt_provider: "elevenlabs",
        stt_model_dir: "/tmp/stt",
        stt_num_threads: 2,
        elevenlabs_api_key: "ek",
        elevenlabs_model_id: "scribe_v1",
        elevenlabs_language_code: "en",
      },
    });

    expect(process.env.VLM_API_KEY).toBe("k");
    expect(process.env.VLM_BASE_URL).toBe("u");
    expect(process.env.VLM_MODEL).toBe("m");
    expect(process.env.VLM_MODEL_LITE).toBe("ml");
    expect(process.env.LLM_MODEL).toBe("lm");
    expect(process.env.VLM_REQUEST_TIMEOUT_MS).toBe("60000");
    expect(process.env.VLM_MAX_RETRIES).toBe("4");
    expect(process.env.VLM_RETRY_BASE_DELAY_MS).toBe("700");
    expect(process.env.VLM_RETRY_MAX_DELAY_MS).toBe("5000");
    expect(process.env.CORTEX_PERCEPTION_SOURCE_CONCURRENCY).toBe("2");
    expect(process.env.CORTEX_PERCEPTION_MAX_QUEUED_PER_SOURCE).toBe("9");
    expect(process.env.CORTEX_PERCEPTION_LIVE_BACKLOG_SKIP_AFTER_MS).toBe("180000");
    expect(process.env.CORTEX_LOCAL_FILE_PACING).toBe("realtime");
    expect(process.env.CORTEX_PERCEPTION_RUNTIME_MODE).toBe("live_latency");
    expect(process.env.WORKING_MEMORY_EVENT_TIMEOUT_SEC).toBe("30");
    expect(process.env.WORKING_MEMORY_MAX_EVENT_SEGMENTS).toBe("12");
    expect(process.env.STUBS_ONLY).toBe("false");
    expect(process.env.CORTEX_PERCEPTION_REQUIRED_LEVEL).toBe("1");
    expect(process.env.CORTEX_MODELS_DIR).toBe("/tmp/models");
    expect(process.env.SCENE_DESCRIPTION).toBe("front lobby");
    expect(process.env.STT_PROVIDER).toBe("elevenlabs");
    expect(process.env.STT_MODEL_DIR).toBe("/tmp/stt");
    expect(process.env.STT_NUM_THREADS).toBe("2");
    expect(process.env.ELEVENLABS_API_KEY).toBe("ek");
    expect(process.env.ELEVENLABS_MODEL_ID).toBe("scribe_v1");
    expect(process.env.ELEVENLABS_LANGUAGE_CODE).toBe("en");
  });

  it("does not bridge pure in-process prompt and service-managed fields", () => {
    bridgePluginConfigToEnv({
      perception: {
        focus_targets: "front desk",
        security_rules: "notify on tailgating",
        profiling_enabled: false,
        cortex_endpoint: "http://localhost:9999",
      },
    });

    expect(process.env.FOCUS_TARGETS).toBeUndefined();
    expect(process.env.SECURITY_RULES).toBeUndefined();
    expect(process.env.CORTEX_PROFILING_ENABLED).toBeUndefined();
    expect(process.env.CORTEX_ENDPOINT).toBeUndefined();
  });

  it("bridges env-source SecretRef credentials to env", () => {
    process.env.__TEST_VLM_SECRET = "secret-from-env";
    const bridged = bridgePluginConfigToEnv({
      perception: {
        vlm_api_key: { source: "env", provider: "default", id: "__TEST_VLM_SECRET" },
      },
    });

    expect(process.env.VLM_API_KEY).toBe("secret-from-env");
    expect((bridged.perception as Record<string, unknown>).vlm_api_key).toBe("secret-from-env");
    delete process.env.__TEST_VLM_SECRET;
  });

  it("removes unsupported SecretRef credentials from returned config", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bridged = bridgePluginConfigToEnv({
      perception: {
        vlm_api_key: { source: "file", provider: "default", id: "/secret" },
        vlm_model: "m",
      },
    });

    expect(process.env.VLM_API_KEY).toBeUndefined();
    expect((bridged.perception as Record<string, unknown>).vlm_api_key).toBeUndefined();
    expect((bridged.perception as Record<string, unknown>).vlm_model).toBe("m");
    warn.mockRestore();
  });

  it("maps memory embedder/llm fields to env but not collection_name", () => {
    bridgePluginConfigToEnv({
      memory: {
        embedder_model: "em",
        embedder_api_key: "ek",
        embedding_dims: 1024,
        collection_name: "should_not_bridge",
      },
    });

    expect(process.env.EMBEDDER_MODEL).toBe("em");
    expect(process.env.EMBEDDER_API_KEY).toBe("ek");
    expect(process.env.EMBEDDING_DIMS).toBe("1024");
    expect(process.env.COLLECTION_PREFIX).toBeUndefined();
  });

  it("pluginConfig overrides existing env for mapped keys", () => {
    process.env.VLM_API_KEY = "from-env-old";
    bridgePluginConfigToEnv({ perception: { vlm_api_key: "from-plugin" } });
    expect(process.env.VLM_API_KEY).toBe("from-plugin");
  });

  it("empty non-secret pluginConfig values override env fallback", () => {
    process.env.STT_PROVIDER = "moonshine";
    bridgePluginConfigToEnv({ perception: { stt_provider: "" } });
    expect(process.env.STT_PROVIDER).toBe("");
  });

  it("leaves env untouched when pluginConfig omits the field", () => {
    process.env.VLM_API_KEY = "from-env";
    bridgePluginConfigToEnv({ perception: { vlm_model: "m" } });
    expect(process.env.VLM_API_KEY).toBe("from-env");
  });
});
