import { describe, expect, it, vi } from "vitest";
import { isSecretRef, normalizeSecretInput } from "../secret-input.js";

describe("secret input helpers", () => {
  it("recognizes OpenClaw SecretRef shape", () => {
    expect(isSecretRef({ source: "env", provider: "default", id: "SECRET_ID" })).toBe(true);
    expect(isSecretRef({ source: "env", id: "SECRET_ID" })).toBe(true);
    expect(isSecretRef({ source: "env" })).toBe(false);
  });

  it("resolves env SecretRef values", () => {
    process.env.__SHARED_SECRET = "resolved";
    expect(normalizeSecretInput({ source: "env", provider: "default", id: "__SHARED_SECRET" })).toBe("resolved");
    delete process.env.__SHARED_SECRET;
  });

  it("warns and returns undefined for unsupported SecretRef sources", () => {
    const warn = vi.fn();
    expect(normalizeSecretInput({ source: "file", provider: "default", id: "/secret" }, "test", warn)).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("[test] SecretRef source \"file\""));
  });
});
