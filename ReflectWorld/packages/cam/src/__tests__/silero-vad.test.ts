import { describe, it, expect } from "vitest";
import { SileroVad, VAD_CHUNK_SIZE } from "../silero-vad.js";

describe("SileroVad", () => {
  it("returns empty segments when not initialized", () => {
    const vad = new SileroVad({ modelPath: "/nonexistent/model.onnx" });
    const chunk = new Float32Array(VAD_CHUNK_SIZE);
    expect(vad.feedChunk(chunk)).toEqual({ segments: [], isSpeaking: false });
  });

  it("flush returns empty when not available", () => {
    const vad = new SileroVad({ modelPath: "/nonexistent/model.onnx" });
    expect(vad.flush()).toEqual([]);
  });

  it("gracefully fails init with bad model path", async () => {
    const vad = new SileroVad({ modelPath: "/nonexistent/model.onnx" });
    const ok = await vad.init();
    expect(vad.isInitialized).toBe(true);
    if (!ok) {
      expect(vad.isAvailable).toBe(false);
      expect(vad.feedChunk(new Float32Array(VAD_CHUNK_SIZE))).toEqual({ segments: [], isSpeaking: false });
    }
  });

  it("VAD_CHUNK_SIZE is 512", () => {
    expect(VAD_CHUNK_SIZE).toBe(512);
  });

  it("dispose does not throw", async () => {
    const vad = new SileroVad({ modelPath: "/nonexistent/model.onnx" });
    await expect(vad.dispose()).resolves.not.toThrow();
  });

  it("feedChunk returns empty when not available", () => {
    const vad = new SileroVad({ modelPath: "/nonexistent/model.onnx" });
    const result = vad.feedChunk(new Float32Array(VAD_CHUNK_SIZE));
    expect(result.segments).toHaveLength(0);
    expect(result.isSpeaking).toBe(false);
  });
});
