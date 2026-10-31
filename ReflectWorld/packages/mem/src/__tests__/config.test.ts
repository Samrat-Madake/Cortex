// packages/mem/src/__tests__/config.test.ts
import { describe, it, expect } from "vitest";
import { parseMemoryConfig, MemoryConfigSchema } from "../config.js";

describe("parseMemoryConfig", () => {
  it("applies defaults for empty input", () => {
    const config = parseMemoryConfig({});
    expect(config.baseUrl).toBe("http://localhost:8219");
    expect(config.timeoutMs).toBe(60_000);
    expect(config.defaultSearchMemoryType).toBe("all");
    expect(config.defaultSearchLimit).toBe(20);
    expect(config.defaultCameraId).toBeUndefined();
  });

  it("accepts valid custom baseUrl", () => {
    const config = parseMemoryConfig({ baseUrl: "http://reflectworld-svc:8219" });
    expect(config.baseUrl).toBe("http://reflectworld-svc:8219");
  });

  it("rejects non-URL baseUrl", () => {
    expect(() => parseMemoryConfig({ baseUrl: "not-a-url" })).toThrow();
  });

  it("rejects negative timeoutMs", () => {
    expect(() => parseMemoryConfig({ timeoutMs: -1 })).toThrow();
  });

  it("accepts defaultCameraId", () => {
    const config = parseMemoryConfig({ defaultCameraId: "cam-front-door" });
    expect(config.defaultCameraId).toBe("cam-front-door");
  });

  it("rejects invalid defaultSearchMemoryType", () => {
    expect(() =>
      parseMemoryConfig({ defaultSearchMemoryType: "invalid_type" }),
    ).toThrow();
  });

  it("accepts all valid memory type values", () => {
    const types = ["episodic", "semantic", "procedural", "all"] as const;
    for (const t of types) {
      const config = parseMemoryConfig({ defaultSearchMemoryType: t });
      expect(config.defaultSearchMemoryType).toBe(t);
    }
  });
});
