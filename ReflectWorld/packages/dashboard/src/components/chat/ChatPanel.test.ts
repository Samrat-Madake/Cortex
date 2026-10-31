import { describe, expect, it } from "vitest";
import { shouldSubmitChatOnKeyDown } from "./ChatPanel.js";

describe("shouldSubmitChatOnKeyDown", () => {
  it("submits a plain Enter key", () => {
    expect(shouldSubmitChatOnKeyDown({
      key: "Enter",
      shiftKey: false,
      isComposing: false,
      keyCode: 13,
    })).toBe(true);
  });

  it("does not submit while an IME composition is active", () => {
    expect(shouldSubmitChatOnKeyDown({
      key: "Enter",
      shiftKey: false,
      isComposing: true,
      keyCode: 13,
    })).toBe(false);
  });

  it("does not submit legacy IME key events", () => {
    expect(shouldSubmitChatOnKeyDown({
      key: "Enter",
      shiftKey: false,
      isComposing: false,
      keyCode: 229,
    })).toBe(false);
  });

  it("keeps Shift+Enter available for a newline", () => {
    expect(shouldSubmitChatOnKeyDown({
      key: "Enter",
      shiftKey: true,
      isComposing: false,
      keyCode: 13,
    })).toBe(false);
  });
});
