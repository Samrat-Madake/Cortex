import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("cortex plugin schema", () => {
  it("declares required_level for all-in-one perception config", () => {
    const plugin = JSON.parse(
      readFileSync(new URL("../../openclaw.plugin.json", import.meta.url), "utf8"),
    ) as {
      configSchema?: {
        properties?: {
          perception?: {
            properties?: Record<string, unknown>;
          };
        };
      };
    };

    expect(plugin.configSchema?.properties?.perception?.properties).toHaveProperty("required_level");
    expect(plugin.configSchema?.properties?.perception?.properties?.required_level).toMatchObject({
      type: "number",
      minimum: 0,
      maximum: 2,
      default: 0,
    });
  });
});
