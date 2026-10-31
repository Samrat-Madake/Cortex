import { describe, expect, it } from "vitest";
import { canAppendFaceGallery, faceReidRejectReason } from "../face-reid-policy.js";
import type { DIdEntry } from "../types.js";

function faceWithSharpness(sharpness: number): DIdEntry["face"] {
  return {
    bbox: { x: 10, y: 10, width: 52, height: 76 },
    landmarks: [
      { x: 20, y: 20 },
      { x: 40, y: 20 },
      { x: 30, y: 35 },
      { x: 22, y: 45 },
      { x: 38, y: 45 },
    ],
    pose: { yaw: 20, pitch: 0, roll: 0 },
    embedding: [1, 0, 0],
    quality: 0.85,
    sharpness,
  };
}

describe("face ReID sharpness policy", () => {
  it("uses the shared hard blur threshold and keeps recognizable soft faces", () => {
    expect(canAppendFaceGallery(faceWithSharpness(16))).toBe(true);
    expect(faceReidRejectReason(faceWithSharpness(16))).toBeUndefined();
  });

  it("rejects faces below the shared hard blur threshold", () => {
    expect(canAppendFaceGallery(faceWithSharpness(14))).toBe(false);
    expect(faceReidRejectReason(faceWithSharpness(14))).toBe("sharpness_lt_15");
  });
});
