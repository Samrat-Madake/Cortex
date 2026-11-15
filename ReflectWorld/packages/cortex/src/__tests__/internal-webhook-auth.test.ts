import { mkdtempSync, statSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isAuthorizedInternalWebhookRequest,
  resolveInternalWebhookToken,
} from "../services/internal-webhook-auth.js";

function request(token?: string, remoteAddress = "127.0.0.1"): IncomingMessage {
  return {
    headers: token ? { "x-cortex-internal-token": token } : {},
    socket: { remoteAddress },
  } as IncomingMessage;
}

describe("internal webhook authentication", () => {
  it("persists generated tokens per state directory with private permissions", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "cortex-webhook-token-"));

    const first = resolveInternalWebhookToken(stateDir);
    const second = resolveInternalWebhookToken(stateDir);

    expect(second).toBe(first);
    expect(first.length).toBeGreaterThanOrEqual(40);
    if (process.platform !== "win32") {
      expect(statSync(join(stateDir, ".internal-webhook-token")).mode & 0o777).toBe(0o600);
    }
  });

  it("uses an explicit configured token without creating a state file", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "cortex-webhook-token-"));

    expect(resolveInternalWebhookToken(stateDir, " configured-secret ")).toBe("configured-secret");
    expect(() => statSync(join(stateDir, ".internal-webhook-token"))).toThrow();
  });

  it("requires a token only in strict mode while always requiring loopback", () => {
    expect(isAuthorizedInternalWebhookRequest(request(), undefined, false)).toBe(true);
    expect(isAuthorizedInternalWebhookRequest(request(), undefined, true)).toBe(false);
    expect(isAuthorizedInternalWebhookRequest(request(), "secret", false)).toBe(true);
    expect(isAuthorizedInternalWebhookRequest(request(), "secret", true)).toBe(false);
    expect(isAuthorizedInternalWebhookRequest(request("secret"), "secret", true)).toBe(true);
    expect(isAuthorizedInternalWebhookRequest(request("wrong"), "secret", true)).toBe(false);
    expect(isAuthorizedInternalWebhookRequest(request("secret", "10.0.0.2"), "secret", true)).toBe(false);
  });
});
