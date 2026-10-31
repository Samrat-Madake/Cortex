import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { resolvePerceptionConfig } from "../config.js";

const CONFIG_ENV_KEYS = [
  "VLM_PROVIDER",
  "VLM_MODEL",
  "VLM_MODEL_LITE",
  "VLM_API_KEY",
  "VLM_BASE_URL",
  "LLM_MODEL",
  "VLM_REQUEST_TIMEOUT_MS",
  "VLM_MAX_RETRIES",
  "VLM_RETRY_BASE_DELAY_MS",
  "VLM_RETRY_MAX_DELAY_MS",
  "REFLECTWORLD_PERCEPTION_SOURCE_CONCURRENCY",
  "REFLECTWORLD_PERCEPTION_MAX_QUEUED_PER_SOURCE",
  "REFLECTWORLD_PERCEPTION_LIVE_BACKLOG_SKIP_AFTER_MS",
  "REFLECTWORLD_PERCEPTION_REQUIRED_LEVEL",
  "REFLECTWORLD_LOCAL_FILE_PACING",
  "REFLECTWORLD_PERCEPTION_RUNTIME_MODE",
  "REFLECTWORLD_ENDPOINT",
  "WORKING_MEMORY_EVENT_TIMEOUT_SEC",
  "WORKING_MEMORY_MAX_EVENT_SEGMENTS",
  "REFLECTWORLD_MODELS_DIR",
  "STUBS_ONLY",
  "SCENE_DESCRIPTION",
  "STT_PROVIDER",
  "STT_MODEL_DIR",
  "STT_NUM_THREADS",
  "ELEVENLABS_API_KEY",
  "ELEVENLABS_MODEL_ID",
  "ELEVENLABS_LANGUAGE_CODE",
  "REFLECTWORLD_BODY_REID_ENABLED",
] as const;

let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const key of CONFIG_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of CONFIG_ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("PerceptionConfigSchema", () => {
  it("applies minimal OpenAI-compatible defaults", () => {
    const config = resolvePerceptionConfig({ vlm_api_key: "test-key" });
    expect(config.vlm_provider).toBe("openai");
    expect(config.vlm_model).toBe("gpt-5-mini");
    expect(config.vlm_model_lite).toBe("gpt-5-mini");
    expect(config.llm_model).toBe("gpt-5-mini");
    expect(config.vlm_api_key).toBe("test-key");
    expect(config.stubs_only).toBe(true);
    expect(config.body_reid_enabled).toBe(false);
  });

  it("applies runtime defaults correctly", () => {
    const config = resolvePerceptionConfig({ vlm_api_key: "key" });
    expect(config.reflectworld_endpoint).toBe("http://localhost:8219");
    expect(config.working_memory_event_timeout_sec).toBe(30);
    expect(config.working_memory_max_event_segments).toBe(18);
    expect(config.vlm_request_timeout_ms).toBe(120000);
    expect(config.vlm_frame_resize_enabled).toBe(false);
    expect(config.vlm_frame_resize_short_edge).toBe(432);
    expect(config.vlm_frame_resize_jpeg_quality).toBe(75);
    expect(config.source_concurrency).toBe(1);
    expect(config.max_queued_per_source).toBe(6);
    expect(config.live_backlog_skip_after_ms).toBe(180000);
    expect(config.local_file_pacing).toBe("fast");
    expect(config.runtime_mode).toBe("offline_quality");
    expect(config.required_level).toBe(0);
  });

  it("accepts overridden values", () => {
    const config = resolvePerceptionConfig({
      vlm_provider: "gemini",
      vlm_model: "gemini-2.5-flash",
      vlm_model_lite: "gemini-2.5-flash-lite",
      vlm_api_key: "key",
      llm_model: "gemini-2.5-flash",
      stubs_only: false,
      working_memory_event_timeout_sec: 60,
      working_memory_max_event_segments: 12,
      vlm_frame_resize_enabled: true,
      vlm_frame_resize_short_edge: 512,
      vlm_frame_resize_jpeg_quality: 80,
      source_concurrency: 2,
      max_queued_per_source: 8,
      live_backlog_skip_after_ms: 120_000,
      required_level: 1,
      local_file_pacing: "fast",
      runtime_mode: "live_latency",
    });
    expect(config.vlm_provider).toBe("gemini");
    expect(config.vlm_model).toBe("gemini-2.5-flash");
    expect(config.vlm_model_lite).toBe("gemini-2.5-flash-lite");
    expect(config.llm_model).toBe("gemini-2.5-flash");
    expect(config.stubs_only).toBe(false);
    expect(config.body_reid_enabled).toBe(false);
    expect(config.working_memory_event_timeout_sec).toBe(60);
    expect(config.working_memory_max_event_segments).toBe(12);
    expect(config.vlm_frame_resize_enabled).toBe(true);
    expect(config.vlm_frame_resize_short_edge).toBe(512);
    expect(config.vlm_frame_resize_jpeg_quality).toBe(80);
    expect(config.source_concurrency).toBe(2);
    expect(config.max_queued_per_source).toBe(8);
    expect(config.live_backlog_skip_after_ms).toBe(120000);
    expect(config.required_level).toBe(1);
    expect(config.local_file_pacing).toBe("fast");
    expect(config.runtime_mode).toBe("live_latency");
  });

  it("reads runtime_mode from REFLECTWORLD_PERCEPTION_RUNTIME_MODE", () => {
    const previous = process.env.REFLECTWORLD_PERCEPTION_RUNTIME_MODE;
    try {
      process.env.REFLECTWORLD_PERCEPTION_RUNTIME_MODE = "live_latency";
      const config = resolvePerceptionConfig({ vlm_api_key: "key" });
      expect(config.runtime_mode).toBe("live_latency");
    } finally {
      if (previous === undefined) delete process.env.REFLECTWORLD_PERCEPTION_RUNTIME_MODE;
      else process.env.REFLECTWORLD_PERCEPTION_RUNTIME_MODE = previous;
    }
  });

  it("reads required_level from REFLECTWORLD_PERCEPTION_REQUIRED_LEVEL", () => {
    const previous = process.env.REFLECTWORLD_PERCEPTION_REQUIRED_LEVEL;
    try {
      process.env.REFLECTWORLD_PERCEPTION_REQUIRED_LEVEL = "1";
      const config = resolvePerceptionConfig({ vlm_api_key: "key" });
      expect(config.required_level).toBe(1);
    } finally {
      if (previous === undefined) delete process.env.REFLECTWORLD_PERCEPTION_REQUIRED_LEVEL;
      else process.env.REFLECTWORLD_PERCEPTION_REQUIRED_LEVEL = previous;
    }
  });

  it("reads live backlog skip threshold from REFLECTWORLD_PERCEPTION_LIVE_BACKLOG_SKIP_AFTER_MS", () => {
    const previous = process.env.REFLECTWORLD_PERCEPTION_LIVE_BACKLOG_SKIP_AFTER_MS;
    try {
      process.env.REFLECTWORLD_PERCEPTION_LIVE_BACKLOG_SKIP_AFTER_MS = "90000";
      const config = resolvePerceptionConfig({ vlm_api_key: "key" });
      expect(config.live_backlog_skip_after_ms).toBe(90000);
    } finally {
      if (previous === undefined) delete process.env.REFLECTWORLD_PERCEPTION_LIVE_BACKLOG_SKIP_AFTER_MS;
      else process.env.REFLECTWORLD_PERCEPTION_LIVE_BACKLOG_SKIP_AFTER_MS = previous;
    }
  });

  it("reads working memory timeout from WORKING_MEMORY_EVENT_TIMEOUT_SEC", () => {
    const previous = process.env.WORKING_MEMORY_EVENT_TIMEOUT_SEC;
    try {
      process.env.WORKING_MEMORY_EVENT_TIMEOUT_SEC = "45";
      const config = resolvePerceptionConfig({ vlm_api_key: "key" });
      expect(config.working_memory_event_timeout_sec).toBe(45);
    } finally {
      if (previous === undefined) delete process.env.WORKING_MEMORY_EVENT_TIMEOUT_SEC;
      else process.env.WORKING_MEMORY_EVENT_TIMEOUT_SEC = previous;
    }
  });

  it("reads stt_num_threads from STT_NUM_THREADS", () => {
    const previous = process.env.STT_NUM_THREADS;
    try {
      process.env.STT_NUM_THREADS = "3";
      const config = resolvePerceptionConfig({ vlm_api_key: "key" });
      expect(config.stt_num_threads).toBe(3);
    } finally {
      if (previous === undefined) delete process.env.STT_NUM_THREADS;
      else process.env.STT_NUM_THREADS = previous;
    }
  });

  it("does not allow VLM frame resize to be controlled by environment variables", () => {
    const previousEnabled = process.env.VLM_FRAME_RESIZE_ENABLED;
    const previousShortEdge = process.env.VLM_FRAME_RESIZE_SHORT_EDGE;
    const previousQuality = process.env.VLM_FRAME_RESIZE_JPEG_QUALITY;
    try {
      process.env.VLM_FRAME_RESIZE_ENABLED = "true";
      process.env.VLM_FRAME_RESIZE_SHORT_EDGE = "512";
      process.env.VLM_FRAME_RESIZE_JPEG_QUALITY = "80";

      const config = resolvePerceptionConfig({ vlm_api_key: "key" });
      expect(config.vlm_frame_resize_enabled).toBe(false);
      expect(config.vlm_frame_resize_short_edge).toBe(432);
      expect(config.vlm_frame_resize_jpeg_quality).toBe(75);
    } finally {
      if (previousEnabled === undefined) delete process.env.VLM_FRAME_RESIZE_ENABLED;
      else process.env.VLM_FRAME_RESIZE_ENABLED = previousEnabled;
      if (previousShortEdge === undefined) delete process.env.VLM_FRAME_RESIZE_SHORT_EDGE;
      else process.env.VLM_FRAME_RESIZE_SHORT_EDGE = previousShortEdge;
      if (previousQuality === undefined) delete process.env.VLM_FRAME_RESIZE_JPEG_QUALITY;
      else process.env.VLM_FRAME_RESIZE_JPEG_QUALITY = previousQuality;
    }
  });

  it("normalizes env-source SecretRef credentials", () => {
    const previous = process.env.__PERCEPT_TEST_KEY;
    try {
      process.env.__PERCEPT_TEST_KEY = "secret-from-env";
      const config = resolvePerceptionConfig({
        vlm_api_key: { source: "env", provider: "default", id: "__PERCEPT_TEST_KEY" },
      });
      expect(config.vlm_api_key).toBe("secret-from-env");
    } finally {
      if (previous === undefined) delete process.env.__PERCEPT_TEST_KEY;
      else process.env.__PERCEPT_TEST_KEY = previous;
    }
  });

  it("enables body ReID only through REFLECTWORLD_BODY_REID_ENABLED", () => {
    const prevNamespaced = process.env.REFLECTWORLD_BODY_REID_ENABLED;
    try {
      delete process.env.REFLECTWORLD_BODY_REID_ENABLED;
      expect(resolvePerceptionConfig({ body_reid_enabled: true }).body_reid_enabled).toBe(false);

      process.env.REFLECTWORLD_BODY_REID_ENABLED = "true";
      expect(resolvePerceptionConfig({}).body_reid_enabled).toBe(true);
    } finally {
      if (prevNamespaced === undefined) delete process.env.REFLECTWORLD_BODY_REID_ENABLED;
      else process.env.REFLECTWORLD_BODY_REID_ENABLED = prevNamespaced;
    }
  });

  it("defaults vlm_api_key to empty string when omitted", () => {
    const config = resolvePerceptionConfig({});
    expect(config.vlm_api_key).toBe("");
  });

  it("rejects invalid vlm_provider", () => {
    expect(() =>
      resolvePerceptionConfig({ vlm_provider: "invalid" as any }),
    ).toThrow();
  });
});
