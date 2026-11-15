import { describe, expect, it } from "vitest";
import {
  buildGoogleLiveSetupMessage,
  hasReliableLiveInputTranscript,
  resolveDashboardLiveAgentConfig,
  shouldReportLiveAgentConnectionClose,
} from "../services/dashboard-live-agent.js";

describe("resolveDashboardLiveAgentConfig", () => {
  it("stays disabled unless explicitly enabled", () => {
    expect(resolveDashboardLiveAgentConfig({ GEMINI_API_KEY: "key" } as NodeJS.ProcessEnv)).toBeNull();
  });

  it("stays disabled when enabled without an API key", () => {
    expect(resolveDashboardLiveAgentConfig({ DASHBOARD_LIVE_AGENT_ENABLED: "true" } as NodeJS.ProcessEnv)).toBeNull();
  });

  it("accepts google/gemini providers and resolves public knobs", () => {
    const config = resolveDashboardLiveAgentConfig({
      DASHBOARD_LIVE_AGENT_ENABLED: "1",
      DASHBOARD_LIVE_AGENT_PROVIDER: "gemini",
      DASHBOARD_LIVE_AGENT_API_KEY: "live-key",
      DASHBOARD_LIVE_AGENT_MODEL: "gemini-live-test",
      DASHBOARD_LIVE_AGENT_HOTKEY: "F9",
      DASHBOARD_LIVE_AGENT_VOICE: "Puck",
      DASHBOARD_LIVE_AGENT_LANGUAGE: "zh",
    } as NodeJS.ProcessEnv);

    expect(config).toMatchObject({
      enabled: true,
      provider: "google",
      apiKey: "live-key",
      model: "gemini-live-test",
      hotkey: "F9",
      voiceName: "Puck",
      language: "zh",
    });
  });

  it("defaults to the current Google Live model", () => {
    const config = resolveDashboardLiveAgentConfig({
      DASHBOARD_LIVE_AGENT_ENABLED: "true",
      GEMINI_API_KEY: "live-key",
    } as NodeJS.ProcessEnv);

    expect(config?.model).toBe("gemini-3.1-flash-live-preview");
    expect(config?.voiceName).toBe("Vega");
  });

  it("builds a Google Live setup payload with the fixed default voice", () => {
    const payload = buildGoogleLiveSetupMessage({
      model: "gemini-3.1-flash-live-preview",
    }) as { setup: Record<string, unknown> };

    expect(payload.setup.model).toBe("models/gemini-3.1-flash-live-preview");
    expect(payload.setup).not.toHaveProperty("responseModalities");
    expect(payload.setup).not.toHaveProperty("speechConfig");
    expect(payload.setup.generationConfig).toMatchObject({
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: "Vega",
          },
        },
      },
    });
    expect(payload.setup).toHaveProperty("inputAudioTranscription");
    expect(payload.setup).toHaveProperty("outputAudioTranscription");
  });

  it("allows overriding the Google Live voice", () => {
    const payload = buildGoogleLiveSetupMessage({
      model: "gemini-3.1-flash-live-preview",
      voiceName: "Puck",
    }) as { setup: Record<string, unknown> };

    expect(payload.setup.generationConfig).toMatchObject({
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: "Puck",
          },
        },
      },
    });
  });

  it("requires real input transcription before executing voice tool calls", () => {
    expect(hasReliableLiveInputTranscript("")).toBe(false);
    expect(hasReliableLiveInputTranscript("   \n\t")).toBe(false);
    expect(hasReliableLiveInputTranscript("What happened recently?")).toBe(true);
  });

  it("does not report an initialized idle probe closing as a service failure", () => {
    expect(shouldReportLiveAgentConnectionClose({
      closing: false,
      wasReady: true,
      turnInFlight: false,
      code: 1000,
    })).toBe(false);
  });

  it("reports startup and in-flight connection failures", () => {
    expect(shouldReportLiveAgentConnectionClose({
      closing: false,
      wasReady: false,
      turnInFlight: false,
      code: 1006,
    })).toBe(true);
    expect(shouldReportLiveAgentConnectionClose({
      closing: false,
      wasReady: true,
      turnInFlight: true,
      code: 1008,
    })).toBe(true);
  });

  it("does not report provider retirement of an initialized idle connection", () => {
    expect(shouldReportLiveAgentConnectionClose({
      closing: false,
      wasReady: true,
      turnInFlight: false,
      code: 1008,
    })).toBe(false);
  });

  it("reports abnormal idle connection failures", () => {
    expect(shouldReportLiveAgentConnectionClose({
      closing: false,
      wasReady: true,
      turnInFlight: false,
      code: 1006,
    })).toBe(true);
  });

  it("does not report closes initiated by the dashboard", () => {
    expect(shouldReportLiveAgentConnectionClose({
      closing: true,
      wasReady: false,
      turnInFlight: true,
      code: 1006,
    })).toBe(false);
  });
});
