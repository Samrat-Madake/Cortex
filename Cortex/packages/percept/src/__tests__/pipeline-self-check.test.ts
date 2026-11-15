import { describe, expect, it } from "vitest";
import {
  collectPipelineSelfCheckComponents,
  logPipelineSelfCheck,
  type PipelineDeps,
} from "../pipeline.js";

function makeBaseDeps(): PipelineDeps {
  return {
    selfCheck: {
      createdAt: "2026-06-04T00:00:00.000Z",
      config: {
        vlm_provider: "openai",
        vlm_api_key: "test-key",
        vlm_base_url: "https://api.openai.com/v1",
        working_memory_event_timeout_sec: 30,
        working_memory_max_event_segments: 15,
        stubs_only: false,
        models_dir: "/tmp/cortex-models",
      } as any,
    },
    router: {
      getMaxLevel: () => 0,
      getAvailableCapabilities: () => [],
      getProviderStatuses: () => [{
        name: "yolo26m-builtin",
        type: "detector",
        runtime: "onnx-builtin",
        ready: false,
        modelId: "yolo26m",
      }],
    } as any,
    modelManager: {
      engine: {
        getLoadedModelExecutionProviders: () => ({}),
      },
    } as any,
  } as PipelineDeps;
}

function makeStrictDeps(): PipelineDeps {
  const deps = makeBaseDeps();
  deps.selfCheck!.config.required_level = 1;
  return deps;
}

describe("pipeline self-check", () => {
  it("warns instead of failing when local models are enabled but native runtime is missing", () => {
    const components = collectPipelineSelfCheckComponents(makeBaseDeps());

    const capabilities = components.find((c) => c.name === "local_model_capabilities");
    const yolo = components.find((c) => c.name === "model:yolo26m-builtin");
    expect(capabilities).toMatchObject({ status: "warn" });
    expect(capabilities?.required).not.toBe(true);
    expect(yolo).toMatchObject({ status: "warn" });
    expect(yolo?.required).not.toBe(true);
    expect(() => logPipelineSelfCheck(makeBaseDeps(), { throwOnFatal: true, logger: () => {} })).not.toThrow();
  });

  it("fails when required_level demands Level 1 but local capabilities are unavailable", () => {
    const components = collectPipelineSelfCheckComponents(makeStrictDeps());

    expect(components.find((c) => c.name === "local_model_capabilities")).toMatchObject({
      status: "error",
      required: true,
    });
    expect(components.find((c) => c.name === "model:yolo26m-builtin")).toMatchObject({
      status: "error",
      required: true,
    });
    expect(() => logPipelineSelfCheck(makeStrictDeps(), { throwOnFatal: true, logger: () => {} }))
      .toThrow(/Pipeline self-check failed: local_model_capabilities, model:yolo26m-builtin/);
  });

  it("fails when required_level demands local models but stubs_only is enabled", () => {
    const deps = makeBaseDeps();
    deps.selfCheck!.config.stubs_only = true;
    deps.selfCheck!.config.required_level = 1;

    expect(collectPipelineSelfCheckComponents(deps).find((c) => c.name === "local_models")).toMatchObject({
      status: "error",
      required: true,
    });
    expect(() => logPipelineSelfCheck(deps, { throwOnFatal: true, logger: () => {} }))
      .toThrow(/Pipeline self-check failed: local_models/);
  });

  it("still fails required infrastructure components when throwOnFatal is enabled", () => {
    const deps = makeBaseDeps();

    expect(() => logPipelineSelfCheck(deps, {
      throwOnFatal: true,
      logger: () => {},
      components: [{
        name: "qdrant",
        status: "error",
        required: true,
        detail: "unreachable",
      }],
    })).toThrow(/Pipeline self-check failed: qdrant/);
  });

  it.each(["sk-your-key-here", "your-vlm-api-key"])(
    "fails fast for placeholder VLM credential %s",
    (placeholder) => {
      const deps = makeBaseDeps();
      deps.selfCheck!.config.vlm_api_key = placeholder;

      const vlm = collectPipelineSelfCheckComponents(deps).find((c) => c.name === "vlm");
      expect(vlm).toMatchObject({
        status: "error",
        required: true,
      });
      expect(vlm?.detail).toContain("placeholder_key=true");
      expect(() => logPipelineSelfCheck(deps, { throwOnFatal: true, logger: () => {} }))
        .toThrow(/Pipeline self-check failed: vlm/);
    },
  );
});
