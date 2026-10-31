// packages/percept/src/__tests__/detection-analyzer.test.ts
import { describe, it, expect, vi } from "vitest";
import { runPerFrameFaceDetection } from "../analyzers/detection-analyzer.js";
import type { ModelRouter } from "../providers/model-router.js";
import type { Frame } from "@reflectworld/shared";
import type { DetectionOutput } from "../types.js";

function makeMockRouter(hasFace = false): ModelRouter {
  return {
    getDetector: (cap: string) => {
      if (cap === "face-detection" && hasFace) {
        return {
          detect: vi.fn().mockResolvedValue({
            boxes: [
              {
                x1: 20,
                y1: 10,
                x2: 40,
                y2: 30,
                confidence: 0.9,
                landmarks: [[25, 15], [35, 15]],
              },
            ],
          }),
        };
      }
      return undefined;
    },
    getReidProvider: () => undefined,
    hasCapability: (cap: string) => cap === "face-detection" && hasFace,
  } as unknown as ModelRouter;
}

describe("runPerFrameFaceDetection", () => {
  it("should attach face detections to frames with person detections", async () => {
    const router = makeMockRouter(true);
    const frames: Frame[] = [{ data: "", timestamp: 0, index: 0 }];
    const detections: DetectionOutput[] = [
      {
        detections: [{ label: "person", confidence: 0.9, bbox: { x: 0, y: 0, width: 100, height: 100 } }],
      },
    ];

    const result = await runPerFrameFaceDetection(frames, detections, router);

    expect(result.detections[0]?.detections[0]?.face).toMatchObject({
      confidence: 0.9,
      bbox: { x: 20, y: 10, width: 20, height: 20 },
    });
    expect(result.debug).toMatchObject([
      {
        frame_idx: 0,
        person_count: 1,
        raw_face_count: 1,
        associated_face_count: 1,
        raw_faces: [{ face_index: 0, short_edge: 20 }],
        associations: [{ body_detection_index: 0, face_index: 0 }],
      },
    ]);
    expect(detections[0]?.detections[0]?.face).toBeUndefined();
  });

  it("should skip face detection when no person is present", async () => {
    const detect = vi.fn();
    const router = {
      getDetector: () => ({ detect }),
      getReidProvider: () => undefined,
      hasCapability: () => true,
    } as unknown as ModelRouter;
    const frames: Frame[] = [{ data: "", timestamp: 0, index: 0 }];
    const detections: DetectionOutput[] = [
      {
        detections: [{ label: "cat", confidence: 0.9, bbox: { x: 0, y: 0, width: 100, height: 100 } }],
      },
    ];

    const result = await runPerFrameFaceDetection(frames, detections, router);

    expect(detect).not.toHaveBeenCalled();
    expect(result.detections[0]?.detections[0]?.face).toBeUndefined();
    expect(result.debug).toMatchObject([
      {
        frame_idx: 0,
        person_count: 0,
        raw_face_count: 0,
        associated_face_count: 0,
        skipped_reason: "no_person_detection",
      },
    ]);
    expect(result.detections).not.toBe(detections);
  });
});
