// packages/percept/src/__tests__/media-uploader.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Segment } from "@reflectworld/shared";
import { MediaUploader, type MediaSaver } from "../media-uploader.js";
import { saveSegmentMedia } from "../pipeline/media.js";

function createMockSaver(): MediaSaver & { calls: Array<{ cameraId: string; segmentId: string; mediaType: string; suffix?: string }> } {
  const calls: Array<{ cameraId: string; segmentId: string; mediaType: string; suffix?: string }> = [];
  return {
    calls,
    saveMedia(cameraId, segmentId, mediaType, _data, suffix) {
      calls.push({ cameraId, segmentId, mediaType, suffix });
      return `/media/${cameraId}/${mediaType}/${segmentId}${suffix ? `_${suffix}` : ""}.${mediaType === "gif" ? "gif" : "jpg"}`;
    },
  };
}

describe("MediaUploader", () => {
  let saver: ReturnType<typeof createMockSaver>;
  let uploader: MediaUploader;

  beforeEach(() => {
    saver = createMockSaver();
    uploader = new MediaUploader(saver);
  });

  it("saveKeyframe delegates to saver with correct params", () => {
    const path = uploader.saveKeyframe("cam1", "seg_001", 3, Buffer.from("jpeg-data"));
    expect(path).toContain("seg_001");
    expect(path).toContain("keyframe");
    expect(saver.calls[0]!.mediaType).toBe("keyframe");
    expect(saver.calls[0]!.suffix).toBe("3");
  });

  it("saveGif delegates to saver", () => {
    const path = uploader.saveGif("cam1", "seg_001", Buffer.from("gif-data"));
    expect(path).toContain("gif");
    expect(saver.calls[0]!.mediaType).toBe("gif");
  });

  it("saveCrop delegates to saver with entity id suffix", () => {
    const path = uploader.saveCrop("cam1", "seg_001", "person_0", Buffer.from("crop-data"));
    expect(path).toContain("crop");
    expect(saver.calls[0]!.suffix).toBe("person_0");
  });

  it("buildMediaUrls constructs a valid MediaUrls object", () => {
    const urls = MediaUploader.buildMediaUrls({
      rawPath: "/media/cam1/raw/seg_001.jpg",
      gifPath: "/media/cam1/gif/seg_001.gif",
      keyframePaths: ["/media/cam1/keyframe/seg_001_0.jpg"],
      cropPaths: ["/media/cam1/crop/seg_001_person_0.jpg"],
    });
    expect(urls.raw).toBe("/media/cam1/raw/seg_001.jpg");
    expect(urls.gif).toBeDefined();
    expect(urls.keyframes).toHaveLength(1);
    expect(urls.crops).toHaveLength(1);
  });

  it("buildMediaUrls handles missing optional fields", () => {
    const urls = MediaUploader.buildMediaUrls({ rawPath: "/media/cam1/raw/seg.jpg" });
    expect(urls.gif).toBeUndefined();
    expect(urls.keyframes).toEqual([]);
    expect(urls.crops).toEqual([]);
  });

  it("saveSegmentMedia creates an animated preview only when enabled", async () => {
    const png1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
    const segment: Segment = {
      segment_id: "seg_animated",
      camera_id: "cam1",
      mode: "event",
      frames: [
        { data: png1x1, timestamp: 1000, index: 0 },
        { data: png1x1, timestamp: 1200, index: 1 },
      ],
      raw_url: "/media/cam1/raw/seg_animated.mp4",
      timestamp: 1000,
      duration_sec: 1,
    };

    const disabled = await saveSegmentMedia({ segment, mediaUploader: uploader, bestFrameIndex: 0 });
    expect(disabled.analysisMedia.gif).toBeUndefined();

    const result = await saveSegmentMedia({
      segment,
      mediaUploader: uploader,
      bestFrameIndex: 0,
      animatedPreview: true,
    });

    expect(result.analysisMedia.keyframes).toHaveLength(1);
    expect(result.analysisMedia.gif).toContain("/media/cam1/gif/seg_animated");
    expect(saver.calls.some((call) => call.mediaType === "gif")).toBe(true);
  });
});
