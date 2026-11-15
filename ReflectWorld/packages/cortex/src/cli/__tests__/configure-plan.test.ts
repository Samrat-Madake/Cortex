import { describe, expect, it } from "vitest";
import {
  assertSupportedEmbedderProvider,
  buildConfigSetArgs,
  configSetValue,
  defaultLlmModel,
  defaultVlmModelLite,
  looksLikeNonDefaultEmbedder,
  mustUseIndependentEmbedder,
  parsePositiveIntegerInput,
  type ConfigureAnswers,
} from "../configure-plan.js";

const base: ConfigureAnswers = {
  vlm_provider: "openai",
  vlm_model: "gpt-4o",
  vlm_api_key: "k",
  vlm_base_url: "https://api.openai.com/v1",
  llm_model: "gpt-5-mini",
  embedderSameGateway: true,
  stt: "off",
};

describe("buildConfigSetArgs", () => {
  it("emits perception sets for VLM and llm_model", () => {
    const paths = buildConfigSetArgs(base).map(([path]) => path);
    expect(paths).toContain("plugins.entries.cortex.config.perception.vlm_provider");
    expect(paths).toContain("plugins.entries.cortex.config.perception.vlm_model");
    expect(paths).toContain("plugins.entries.cortex.config.perception.vlm_model_lite");
    expect(paths).toContain("plugins.entries.cortex.config.perception.vlm_api_key");
    expect(paths).toContain("plugins.entries.cortex.config.perception.vlm_base_url");
    expect(paths).toContain("plugins.entries.cortex.config.perception.llm_model");
  });

  it("uses provider-aware vlm_model_lite defaults", () => {
    const openai = buildConfigSetArgs(base);
    const gemini = buildConfigSetArgs({
      ...base,
      vlm_provider: "gemini",
      vlm_model: "gemini-2.5-flash",
      vlm_base_url: "",
      llm_model: "gemini-2.5-flash",
      embedderSameGateway: false,
      embedder_model: "text-embedding-3-small",
      embedder_api_key: "ek",
    });

    expect(openai.find(([path]) => path.endsWith(".vlm_model_lite"))?.[1]).toBe("gpt-5-mini");
    expect(gemini.find(([path]) => path.endsWith(".vlm_model_lite"))?.[1]).toBe("gemini-2.5-flash");
  });

  it("defaults openai base_url to official when blank", () => {
    const cmds = buildConfigSetArgs({ ...base, vlm_base_url: "" });
    expect(cmds.find(([path]) => path.endsWith(".vlm_base_url"))?.[1]).toBe("https://api.openai.com/v1");
  });

  it("does not emit memory embedder fields when embedder inherits VLM gateway", () => {
    const cmds = buildConfigSetArgs(base);
    expect(cmds.some(([path]) => path.includes(".memory.embedder_"))).toBe(false);
  });

  it("rejects gemini same-gateway embedder because memory needs OpenAI-compatible embeddings", () => {
    expect(() => buildConfigSetArgs({
      ...base,
      vlm_provider: "gemini",
      vlm_model: "gemini-2.5-flash",
      vlm_base_url: "",
      llm_model: "gemini-2.5-flash",
      embedderSameGateway: true,
    })).toThrow(/independent OpenAI-compatible embedder/);
  });

  it("emits independent memory embedder fields", () => {
    const cmds = buildConfigSetArgs({
      ...base,
      embedderSameGateway: false,
      embedder_provider: "openai",
      embedder_model: "text-embedding-3-large",
      embedder_api_key: "ek",
      embedder_base_url: "u",
    });
    expect(cmds.some(([path]) => path === "plugins.entries.cortex.config.memory.embedder_model")).toBe(true);
    expect(cmds.find(([path]) => path.endsWith(".embedder_provider"))?.[1]).toBe("openai");
    expect(cmds.find(([path]) => path.endsWith(".embedder_api_key"))?.[1]).toBe("ek");
    expect(cmds.find(([path]) => path.endsWith(".embedder_base_url"))?.[1]).toBe("u");
  });

  it("defaults independent openai embedder base_url to official when blank", () => {
    const cmds = buildConfigSetArgs({
      ...base,
      embedderSameGateway: false,
      embedder_provider: "openai",
      embedder_model: "text-embedding-3-small",
      embedder_api_key: "ek",
      embedder_base_url: "",
    });

    expect(cmds.find(([path]) => path.endsWith(".embedder_base_url"))?.[1]).toBe("https://api.openai.com/v1");
  });

  it("rejects unsupported embedder providers", () => {
    expect(() => assertSupportedEmbedderProvider("voyage")).toThrow(/Unsupported embedder provider/);
    expect(() => buildConfigSetArgs({
      ...base,
      embedderSameGateway: false,
      embedder_provider: "voyage",
      embedder_model: "voyage-3",
      embedder_api_key: "ek",
    })).toThrow(/Unsupported embedder provider/);
  });

  it("emits elevenlabs STT config", () => {
    const paths = buildConfigSetArgs({ ...base, stt: "elevenlabs", elevenlabs_api_key: "ek" }).map(([path]) => path);
    expect(paths).toContain("plugins.entries.cortex.config.perception.stt_provider");
    expect(paths).toContain("plugins.entries.cortex.config.perception.elevenlabs_api_key");
  });

  it("emits disabled STT provider for stt=off", () => {
    const cmds = buildConfigSetArgs(base);
    expect(cmds.find(([path]) => path.endsWith(".stt_provider"))?.[1]).toBe("");
  });

  it("emits moonshine stt_model_dir", () => {
    const cmds = buildConfigSetArgs({ ...base, stt: "moonshine", stt_model_dir: "/m/dir" });
    expect(cmds.map(([path]) => path)).toContain("plugins.entries.cortex.config.perception.stt_provider");
    expect(cmds.find(([path]) => path.endsWith(".stt_model_dir"))?.[1]).toBe("/m/dir");
  });

  it("emits embedding_dims and new collection_name for independent embedder changes", () => {
    const cmds = buildConfigSetArgs({
      ...base,
      embedderSameGateway: false,
      embedder_model: "voyage-3",
      embedder_api_key: "ek",
      embedding_dims: 1024,
      collection_name: "cortex_voyage",
    });
    expect(cmds.find(([path]) => path === "plugins.entries.cortex.config.memory.embedding_dims")?.[1]).toBe("1024");
    expect(cmds.find(([path]) => path === "plugins.entries.cortex.config.memory.collection_name")?.[1]).toBe("cortex_voyage");
  });

  it("exposes provider-specific defaults and embedder guard helpers", () => {
    expect(defaultVlmModelLite("gemini", "gemini-2.5-flash")).toBe("gemini-2.5-flash");
    expect(defaultLlmModel("gemini", "gemini-2.5-flash")).toBe("gemini-2.5-flash");
    expect(defaultVlmModelLite("openai", "gpt-4o")).toBe("gpt-5-mini");
    expect(defaultLlmModel("openai", "gpt-4o")).toBe("gpt-5-mini");
    expect(mustUseIndependentEmbedder("gemini")).toBe(true);
    expect(mustUseIndependentEmbedder("openai")).toBe(false);
  });

  it("detects embedder changes that require a new collection", () => {
    expect(looksLikeNonDefaultEmbedder("text-embedding-3-small", 1536)).toBe(false);
    expect(looksLikeNonDefaultEmbedder("text-embedding-3-large", 1536)).toBe(true);
    expect(looksLikeNonDefaultEmbedder("text-embedding-3-small", 1024)).toBe(true);
  });

  it("quotes string config values but leaves embedding_dims numeric", () => {
    expect(configSetValue("plugins.entries.cortex.config.perception.vlm_model", "true")).toBe("\"true\"");
    expect(configSetValue("plugins.entries.cortex.config.perception.vlm_api_key", "12345")).toBe("\"12345\"");
    expect(configSetValue("plugins.entries.cortex.config.memory.embedding_dims", "1024")).toBe("1024");
  });

  it("parses embedding dims as strict positive integers", () => {
    expect(parsePositiveIntegerInput("1536", "embedding dims")).toBe(1536);
    expect(parsePositiveIntegerInput(" 1024 ", "embedding dims")).toBe(1024);
    expect(() => parsePositiveIntegerInput("1536abc", "embedding dims")).toThrow(/Invalid embedding dims/);
    expect(() => parsePositiveIntegerInput("0", "embedding dims")).toThrow(/Invalid embedding dims/);
    expect(() => parsePositiveIntegerInput("-1", "embedding dims")).toThrow(/Invalid embedding dims/);
  });
});
