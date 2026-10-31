import { describe, expect, it } from "vitest";
import { bestDisplayName } from "./useEntityAliases";

describe("bestDisplayName", () => {
  it("keeps a real identity when an older automatic person label is observed later", () => {
    expect(bestDisplayName("Person 8", "Jensen Huang")).toBe("Jensen Huang");
  });

  it("replaces an automatic person label with a real identity", () => {
    expect(bestDisplayName("Michael Dell", "Person 5")).toBe("Michael Dell");
  });
});
