import { describe, expect, it } from "vitest";
import {
  collectFaceQualificationDebug,
  collectQualifiedFaces,
} from "../analyzers/subject-proposal-analyzer.js";
import type { DetectionOutput } from "../types.js";

describe("subject-proposal face qualification debug", () => {
  it("mirrors qualified face collection and records rejection reasons", () => {
    const detections: DetectionOutput[] = [
      {
        detections: [
          {
            label: "person",
            confidence: 0.9,
            bbox: { x: 0, y: 0, width: 200, height: 300 },
            face: {
              confidence: 0.95,
              bbox: { x: 50, y: 30, width: 60, height: 60 },
              landmarks: [
                { x: 65, y: 50 },
                { x: 95, y: 50 },
                { x: 80, y: 65 },
                { x: 68, y: 88 },
                { x: 92, y: 88 },
              ],
            },
          },
          {
            label: "person",
            confidence: 0.8,
            bbox: { x: 220, y: 0, width: 80, height: 160 },
            face: {
              confidence: 0.85,
              bbox: { x: 235, y: 20, width: 20, height: 20 },
            },
          },
          {
            label: "person",
            confidence: 0.7,
            bbox: { x: 320, y: 0, width: 80, height: 160 },
          },
        ],
      },
    ];

    const faces = collectQualifiedFaces(detections, 640, 360);
    const debug = collectFaceQualificationDebug(detections, 640, 360);

    expect(faces).toHaveLength(1);
    expect(debug).toHaveLength(3);
    expect(debug[0]).toMatchObject({
      frame_idx: 0,
      detection_idx: 0,
      has_face: true,
      qualified: true,
      face_short_edge: 60,
    });
    expect(debug[1]).toMatchObject({
      detection_idx: 1,
      has_face: true,
      qualified: false,
      rejected_reason: "face_short_edge_lt_min",
      face_short_edge: 20,
    });
    expect(debug[2]).toMatchObject({
      detection_idx: 2,
      has_face: false,
      qualified: false,
      rejected_reason: "missing_face",
    });
  });
});
