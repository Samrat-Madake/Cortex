import { describe, it, expect, vi } from "vitest";
import { Notifier } from "../notifier.js";
import type { DeliveryResult } from "../notifier.js";

describe("Notifier", () => {
  const testSessionKey = "agent:main:discord:channel:123456";

  function setup() {
    const sendCalls: Array<{ channel: string; to: string; text: string; mediaUrl?: string }> = [];
    const subagentCalls: Array<{ sessionKey: string; message: string }> = [];

    const deps = {
      sendMessage: vi.fn(async (channel: string, to: string, text: string, mediaUrl?: string) => {
        sendCalls.push({ channel, to, text, mediaUrl });
      }),
      subagentRun: vi.fn(async (params: { sessionKey: string; message: string; deliver: boolean; idempotencyKey: string }) => {
        subagentCalls.push({ sessionKey: params.sessionKey, message: params.message });
        return { runId: "test-run-id" };
      }),
      parseSessionKey: (sk: string) => {
        const parts = sk.split(":");
        if (parts.length >= 5) return { channel: parts[2], to: parts.slice(4).join(":") };
        return null;
      },
      logger: {
        info: vi.fn(),
        error: vi.fn(),
      },
    };

    const notifier = new Notifier(deps);
    return { notifier, deps, sendCalls, subagentCalls };
  }

  it("sendAlert uses direct send (Path A) with correct channel routing", async () => {
    const { notifier, sendCalls } = setup();
    await notifier.sendAlert("Potential break-in detected", "cam_back", testSessionKey);

    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]!.channel).toBe("discord");
    expect(sendCalls[0]!.to).toBe("123456");
    expect(sendCalls[0]!.text).toBe("\u{1F6A8} [cam_back] Potential break-in detected");
  });

  it("sendAlert attaches keyframe image", async () => {
    const { notifier, sendCalls } = setup();
    await notifier.sendAlert("Break-in", "cam_a", testSessionKey, "/tmp/frame.jpg");

    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]!.mediaUrl).toBe("/tmp/frame.jpg");
  });

  it("sendSummary uses subagent (Path B) with correct session key", async () => {
    const { notifier, subagentCalls } = setup();
    await notifier.sendSummary("A person arrived at the front door", "cam_front", testSessionKey);

    expect(subagentCalls).toHaveLength(1);
    expect(subagentCalls[0]!.sessionKey).toBe(testSessionKey);
    expect(subagentCalls[0]!.message).toContain("[cam_front] A person arrived at the front door");
  });

  it("sendSummary sends keyframe as follow-up after subagent", async () => {
    const { notifier, sendCalls, subagentCalls } = setup();
    await notifier.sendSummary("test", "cam_a", testSessionKey, "/tmp/frame.jpg");

    expect(subagentCalls).toHaveLength(1);
    // Keyframe sent as direct follow-up
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]!.mediaUrl).toBe("/tmp/frame.jpg");
    expect(sendCalls[0]!.text).toBe("");
  });

  it("sendIdentify uses subagent (Path B)", async () => {
    const { notifier, subagentCalls } = setup();
    await notifier.sendIdentify("Unknown person in dark hoodie", "cam_front", testSessionKey);

    expect(subagentCalls).toHaveLength(1);
    expect(subagentCalls[0]!.message).toContain("[cam_front] Unknown person in dark hoodie");
  });

  it("sendSummary falls back to direct send with image when subagent fails", async () => {
    const { notifier, deps, sendCalls } = setup();
    deps.subagentRun.mockRejectedValueOnce(new Error("subagent unavailable"));

    await notifier.sendSummary("test summary", "cam_a", testSessionKey, "/tmp/frame.jpg");

    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]!.text).toBe("\u{1F4F7} [cam_a] test summary");
    expect(sendCalls[0]!.mediaUrl).toBe("/tmp/frame.jpg");
  });

  it("logs error when no sessionKey is provided", async () => {
    const { notifier, deps, sendCalls, subagentCalls } = setup();
    await notifier.sendAlert("test alert", "cam_a");
    await notifier.sendSummary("test summary", "cam_a");

    expect(sendCalls).toHaveLength(0);
    expect(subagentCalls).toHaveLength(0);
    expect(deps.logger.error).toHaveBeenCalledTimes(2);
  });

  it("webchat session key: subagent works, direct send returns null", async () => {
    const webchatKey = "agent:main:main";
    const { notifier, subagentCalls, sendCalls } = setup();

    // Path B (subagent) works with webchat session
    await notifier.sendSummary("test summary", "cam_a", webchatKey);
    expect(subagentCalls).toHaveLength(1);
    expect(subagentCalls[0]!.sessionKey).toBe(webchatKey);

    // Path A (direct send) cannot parse webchat key — logs error
    await notifier.sendAlert("test alert", "cam_a", webchatKey);
    expect(sendCalls).toHaveLength(0);
  });

  it("omits sourceId bracket when not provided", async () => {
    const { notifier, sendCalls, subagentCalls } = setup();

    await notifier.sendAlert("bare alert", undefined, testSessionKey);
    await notifier.sendSummary("bare summary", undefined, testSessionKey);

    expect(sendCalls[0]!.text).toBe("\u{1F6A8} bare alert");
    expect(subagentCalls[0]!.message).toContain("\u{1F4F7} bare summary");
  });

  // ── Delivery tracking tests ──

  it("sendAlert returns delivered=true on success", async () => {
    const { notifier } = setup();
    const result = await notifier.sendAlert("test", "cam_a", testSessionKey);

    expect(result.delivered).toBe(true);
    expect(result.delivery_ms).toBeGreaterThanOrEqual(0);
    expect(result.delivery_error).toBeUndefined();
  });

  it("sendAlert returns delivered=false when no sessionKey", async () => {
    const { notifier } = setup();
    const result = await notifier.sendAlert("test", "cam_a");

    expect(result.delivered).toBe(false);
    expect(result.delivery_error).toBe("no sessionKey");
  });

  it("sendAlert returns delivered=false when sessionKey unparseable", async () => {
    const { notifier } = setup();
    const result = await notifier.sendAlert("test", "cam_a", "agent:main:main");

    expect(result.delivered).toBe(false);
    expect(result.delivery_error).toContain("cannot parse sessionKey");
  });

  it("sendAlert returns delivered=false with error message on send failure", async () => {
    const { notifier, deps } = setup();
    deps.sendMessage.mockRejectedValueOnce(new Error("network timeout"));

    const result = await notifier.sendAlert("test", "cam_a", testSessionKey);

    expect(result.delivered).toBe(false);
    expect(result.delivery_error).toBe("network timeout");
    expect(result.delivery_ms).toBeGreaterThanOrEqual(0);
  });

  it("sendSummary returns delivered=true on subagent success", async () => {
    const { notifier } = setup();
    const result = await notifier.sendSummary("test", "cam_a", testSessionKey);

    expect(result.delivered).toBe(true);
    expect(result.delivery_ms).toBeGreaterThanOrEqual(0);
  });

  it("sendSummary returns delivered=true when fallback succeeds", async () => {
    const { notifier, deps } = setup();
    deps.subagentRun.mockRejectedValueOnce(new Error("subagent down"));

    const result = await notifier.sendSummary("test", "cam_a", testSessionKey);

    expect(result.delivered).toBe(true);
  });

  it("sendSummary returns delivered=false when both subagent and fallback fail", async () => {
    const { notifier, deps } = setup();
    deps.subagentRun.mockRejectedValueOnce(new Error("subagent down"));
    deps.sendMessage.mockRejectedValueOnce(new Error("channel offline"));

    const result = await notifier.sendSummary("test", "cam_a", testSessionKey);

    expect(result.delivered).toBe(false);
    expect(result.delivery_error).toContain("subagent: subagent down");
    expect(result.delivery_error).toContain("fallback: channel offline");
  });

  it("sendSummary returns delivered=false when no sessionKey", async () => {
    const { notifier } = setup();
    const result = await notifier.sendSummary("test", "cam_a");

    expect(result.delivered).toBe(false);
    expect(result.delivery_error).toBe("no sessionKey");
  });

  it("sendIdentify returns delivered=true on success", async () => {
    const { notifier } = setup();
    const result = await notifier.sendIdentify("test", "cam_a", testSessionKey);

    expect(result.delivered).toBe(true);
    expect(result.delivery_ms).toBeGreaterThanOrEqual(0);
  });

  it("sendIdentify returns delivered=false when both paths fail", async () => {
    const { notifier, deps } = setup();
    deps.subagentRun.mockRejectedValueOnce(new Error("subagent down"));
    deps.sendMessage.mockRejectedValueOnce(new Error("channel offline"));

    const result = await notifier.sendIdentify("test", "cam_a", testSessionKey);

    expect(result.delivered).toBe(false);
    expect(result.delivery_error).toContain("subagent: subagent down");
    expect(result.delivery_error).toContain("fallback: channel offline");
  });

  it("delivery_ms tracks elapsed time", async () => {
    const { notifier, deps } = setup();
    // Simulate slow send
    deps.sendMessage.mockImplementationOnce(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    const result = await notifier.sendAlert("test", "cam_a", testSessionKey);

    expect(result.delivered).toBe(true);
    expect(result.delivery_ms).toBeGreaterThanOrEqual(15);
  });
});
