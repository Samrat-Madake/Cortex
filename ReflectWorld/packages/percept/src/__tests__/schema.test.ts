import { describe, it, expect } from "vitest";
import { PerceptionToolSchema } from "../schema.js";

describe("PerceptionToolSchema", () => {
  it("only advertises runtime-hot configurable perception fields", () => {
    const configSchema = (PerceptionToolSchema as any).properties.config;
    const properties = configSchema.properties as Record<string, unknown>;

    expect(properties).toHaveProperty("vlm_model");
    expect(properties).toHaveProperty("vlm_model_lite");
    expect(properties).toHaveProperty("scene_description");
    expect(properties).toHaveProperty("vc_rules_json");
    expect(properties).toHaveProperty("semantic_context_notes");

    expect(properties).not.toHaveProperty("vlm_provider");
    expect(properties).not.toHaveProperty("vlm_api_key");
    expect(properties).not.toHaveProperty("vlm_base_url");
    expect(properties).not.toHaveProperty("llm_model");
    expect(properties).not.toHaveProperty("stubs_only");
    expect(properties).not.toHaveProperty("required_level");
  });
});
