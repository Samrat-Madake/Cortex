import { describe, expect, it, vi } from "vitest";
import {
  collectConfigureAnswers,
  createPipedPrompter,
  restartOpenClawGateway,
} from "../configure.js";

describe("configure CLI prompting", () => {
  it("consumes piped answers in order without readline buffering loss", async () => {
    const output = { write: vi.fn() };
    const prompter = createPipedPrompter([
      "openai",
      "gpt-4o",
      "",
      "sk-test",
      "",
      "",
      "y",
      "off",
      "",
    ].join("\n"), output);

    const answers = await collectConfigureAnswers(prompter);

    expect(answers).toMatchObject({
      vlm_provider: "openai",
      vlm_model: "gpt-4o",
      vlm_model_lite: "gpt-5-mini",
      vlm_api_key: "sk-test",
      vlm_base_url: "https://api.openai.com/v1",
      llm_model: "gpt-5-mini",
      embedderSameGateway: true,
      stt: "off",
    });
    expect(output.write).toHaveBeenCalled();
  });

  it("fails clearly when piped input runs out before required answers", async () => {
    const prompter = createPipedPrompter("openai\n\n", { write: vi.fn() });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(collectConfigureAnswers(prompter)).rejects.toThrow(/No piped answer available/);
    log.mockRestore();
  });
});

describe("restartOpenClawGateway", () => {
  it("returns true when gateway restart succeeds", () => {
    const run = vi.fn(() => "");

    expect(restartOpenClawGateway(run)).toBe(true);
    expect(run).toHaveBeenCalledWith(["gateway", "restart"], { stdio: "inherit" });
  });

  it("warns instead of failing when managed gateway restart is not available", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const run = vi.fn(() => {
      throw new Error("service not loaded");
    });

    expect(restartOpenClawGateway(run)).toBe(false);
    expect(warn.mock.calls.flat().join("\n")).toContain("Restart the OpenClaw gateway process manually");
    warn.mockRestore();
  });
});
