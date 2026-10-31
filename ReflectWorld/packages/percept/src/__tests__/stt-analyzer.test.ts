import { describe, it, expect } from "vitest";
import { SttAnalyzer } from "../analyzers/stt-analyzer.js";

describe("SttAnalyzer", () => {
  it("returns empty transcript when not initialized", () => {
    const stt = new SttAnalyzer({ modelDir: "/nonexistent/model" });
    const result = stt.transcribe([
      { start: 0, samples: new Float32Array(16000) },
    ]);
    expect(result.transcript).toBe("");
    expect(result.segments).toHaveLength(0);
    expect(result.latency_ms).toBe(0);
  });

  it("returns empty transcript when no segments provided", () => {
    const stt = new SttAnalyzer({ modelDir: "/nonexistent/model" });
    const result = stt.transcribe([]);
    expect(result.transcript).toBe("");
    expect(result.segments).toHaveLength(0);
  });

  it("gracefully fails init with bad model path", async () => {
    const stt = new SttAnalyzer({ modelDir: "/nonexistent/model" });
    const ok = await stt.init();
    // Will fail because either sherpa-onnx-node not installed or model not found
    expect(ok).toBe(false);
    expect(stt.isAvailable).toBe(false);
  });

  it("dispose does not throw", () => {
    const stt = new SttAnalyzer({ modelDir: "/nonexistent/model" });
    expect(() => stt.dispose()).not.toThrow();
    expect(stt.isAvailable).toBe(false);
  });

  it("isAvailable is false before init", () => {
    const stt = new SttAnalyzer({ modelDir: "/nonexistent/model" });
    expect(stt.isAvailable).toBe(false);
  });
});
