import { describe, it, expect, vi } from "vitest";
import { FrameAnalyzer } from "../frame-analyzer.js";

function makeFrame(timestamp = 0) {
  return { data: Buffer.from([0xff, 0xd8]).toString("base64"), timestamp, source_name: "cam1" };
}

describe("FrameAnalyzer", () => {
  it("calls onDetection with detection results", async () => {
    const mockDetector = {
      detect: vi.fn().mockResolvedValue({
        boxes: [{ x1: 10, y1: 20, x2: 100, y2: 200, confidence: 0.9, class_id: 0, class_name: "person" }],
      }),
    };
    const router = { getDetector: vi.fn().mockReturnValue(mockDetector) } as any;
    const analyzer = new FrameAnalyzer({ router });
    const onDetection = vi.fn();

    analyzer.feedFrame(makeFrame(1000), "cam1", onDetection);
    await new Promise((r) => setTimeout(r, 50));

    expect(onDetection).toHaveBeenCalledTimes(1);
    const result = onDetection.mock.calls[0][0];
    expect(result.camera_id).toBe("cam1");
    expect(result.frame_timestamp).toBe(1000);
    expect(result.detections).toHaveLength(1);
    expect(result.detections[0].label).toBe("person");
  });

  it("skips detection when the same live camera is busy", async () => {
    let resolveDetect: () => void;
    const slowDetect = new Promise<void>((r) => { resolveDetect = r; });
    const mockDetector = {
      detect: vi.fn().mockImplementation(() => slowDetect.then(() => ({ boxes: [] }))),
    };
    const router = { getDetector: vi.fn().mockReturnValue(mockDetector) } as any;
    const analyzer = new FrameAnalyzer({ router });
    const onDetection = vi.fn();
    const onDrop = vi.fn();

    analyzer.feedFrame(makeFrame(1000), "cam1", onDetection, { policy: "latest_only", onDrop });
    analyzer.feedFrame(makeFrame(2000), "cam1", onDetection, { policy: "latest_only", onDrop });

    resolveDetect!();
    await new Promise((r) => setTimeout(r, 50));

    expect(mockDetector.detect).toHaveBeenCalledTimes(1);
    expect(onDetection).toHaveBeenCalledTimes(1);
    expect(onDrop).toHaveBeenCalledWith(expect.objectContaining({
      camera_id: "cam1",
      frame_timestamp: 2000,
      dropped_total: 1,
      reason: "camera_busy",
    }));
  });

  it("does not let one live camera busy flag drop another camera", async () => {
    let resolveDetect: () => void;
    const slowDetect = new Promise<void>((r) => { resolveDetect = r; });
    const mockDetector = {
      detect: vi.fn().mockImplementation(() => slowDetect.then(() => ({ boxes: [] }))),
    };
    const router = { getDetector: vi.fn().mockReturnValue(mockDetector) } as any;
    const analyzer = new FrameAnalyzer({ router });
    const onDetection = vi.fn();
    const onDrop = vi.fn();

    analyzer.feedFrame(makeFrame(1000), "cam1", onDetection, { policy: "latest_only", onDrop });
    analyzer.feedFrame(makeFrame(2000), "cam2", onDetection, { policy: "latest_only", onDrop });

    resolveDetect!();
    await new Promise((r) => setTimeout(r, 50));

    expect(mockDetector.detect).toHaveBeenCalledTimes(2);
    expect(onDetection).toHaveBeenCalledTimes(2);
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("serializes local-file frames without dropping detections", async () => {
    let releaseFirst!: () => void;
    const firstDetect = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const mockDetector = {
      detect: vi.fn()
        .mockImplementationOnce(() => firstDetect.then(() => ({ boxes: [] })))
        .mockResolvedValue({ boxes: [] }),
    };
    const router = { getDetector: vi.fn().mockReturnValue(mockDetector) } as any;
    const analyzer = new FrameAnalyzer({ router });
    const onDetection = vi.fn();
    const onDrop = vi.fn();

    const first = analyzer.feedFrame(makeFrame(1000), "cam1", onDetection, { policy: "lossless", onDrop });
    const second = analyzer.feedFrame(makeFrame(2000), "cam1", onDetection, { policy: "lossless", onDrop });

    await new Promise((r) => setTimeout(r, 0));
    expect(mockDetector.detect).toHaveBeenCalledTimes(1);
    releaseFirst();
    await Promise.all([first, second]);

    expect(mockDetector.detect).toHaveBeenCalledTimes(2);
    expect(onDetection).toHaveBeenCalledTimes(2);
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("returns empty detections when no detector available", async () => {
    const router = { getDetector: vi.fn().mockReturnValue(undefined) } as any;
    const analyzer = new FrameAnalyzer({ router });
    const onDetection = vi.fn();

    analyzer.feedFrame(makeFrame(1000), "cam1", onDetection);
    await new Promise((r) => setTimeout(r, 50));

    expect(onDetection).toHaveBeenCalledTimes(1);
    expect(onDetection.mock.calls[0][0].detections).toEqual([]);
  });
});
