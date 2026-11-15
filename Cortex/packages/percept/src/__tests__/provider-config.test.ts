// packages/percept/src/__tests__/provider-config.test.ts
import { describe, it, expect } from "vitest";
import { ProviderConfigSchema, DEFAULT_PROVIDER_CONFIG, type ProviderConfig } from "../providers/provider-config.js";

describe("ProviderConfig", () => {
  it("should parse default config without errors", () => {
    const result = ProviderConfigSchema.safeParse(DEFAULT_PROVIDER_CONFIG);
    expect(result.success).toBe(true);
  });

  it("should accept empty config and apply defaults", () => {
    const result = ProviderConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.providers).toBeDefined();
      expect(result.data.routing).toBeDefined();
    }
  });

  it("should validate routing references existing providers", () => {
    const config: ProviderConfig = {
      ...DEFAULT_PROVIDER_CONFIG,
      routing: {
        "general-detection": ["yolo26m-builtin"],
        "face-detection": ["retinaface-builtin"],
        "face-reid": ["adaface-builtin"],
        "body-reid": ["clip-reid-builtin"],
      },
    };
    const result = ProviderConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  it("should accept custom provider with remote runtime", () => {
    const config = {
      ...DEFAULT_PROVIDER_CONFIG,
      providers: {
        ...DEFAULT_PROVIDER_CONFIG.providers,
        "my-custom-detector": {
          type: "detector",
          runtime: "remote",
          endpoint: "http://localhost:9000/detect",
        },
      },
    };
    const result = ProviderConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });
});
