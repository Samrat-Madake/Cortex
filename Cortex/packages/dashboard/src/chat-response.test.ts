import { describe, expect, it } from "vitest";
import { DASHBOARD_CHAT_UNAVAILABLE_MESSAGE, resolveDashboardChatReply } from "./chat-response.js";

describe("resolveDashboardChatReply", () => {
  it("shows an explicit backend error instead of a partial local answer", () => {
    expect(resolveDashboardChatReply(
      "There are no Ferraris in the recent moments.",
      "I cannot reliably verify the full video right now.",
    )).toBe("I cannot reliably verify the full video right now.");
  });

  it("returns a successful backend answer", () => {
    expect(resolveDashboardChatReply("Two Ferraris are visible.", undefined)).toBe("Two Ferraris are visible.");
  });

  it("uses a non-video-specific fallback when no backend message is available", () => {
    expect(resolveDashboardChatReply(undefined, undefined)).toBe(DASHBOARD_CHAT_UNAVAILABLE_MESSAGE);
  });
});
