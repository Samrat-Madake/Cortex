import { describe, expect, it } from "vitest";
import {
  directFileUrlForPreview,
  initialUploadPlaybackState,
  reduceUploadPlaybackState,
  uploadPlaybackUrl,
} from "./liveVideoPlayback";

describe("live video upload playback fallback", () => {
  it("derives a direct file URL from a preview URL without dropping dashboard query params", () => {
    expect(directFileUrlForPreview(
      "/api/videos/preview?video_id=fixture%2Foffice_cup.mp4&session_id=s1&user_id=u1",
      "https://demo.example.com/dashboard",
    )).toBe("/api/videos/file?video_id=fixture%2Foffice_cup.mp4&session_id=s1&user_id=u1");
  });

  it("keeps absolute preview URLs absolute when deriving the direct file URL", () => {
    expect(directFileUrlForPreview(
      "https://demo.example.com/api/videos/preview?video_id=upload%2Fclip.mp4",
    )).toBe("https://demo.example.com/api/videos/file?video_id=upload%2Fclip.mp4");
  });

  it("falls back from direct playback to preview playback and clears the preparing state once playable", () => {
    const previewUrl = "/api/videos/preview?video_id=fixture%2Foffice_cup.mp4";
    const directUrl = directFileUrlForPreview(previewUrl, "https://demo.example.com/");
    let state = initialUploadPlaybackState(Boolean(directUrl));

    expect(uploadPlaybackUrl(previewUrl, state, directUrl)).toBe("/api/videos/file?video_id=fixture%2Foffice_cup.mp4");

    state = reduceUploadPlaybackState(state, "direct_unavailable");
    expect(state).toEqual({ mode: "preview", preparing: true });
    expect(uploadPlaybackUrl(previewUrl, state, directUrl)).toBe(previewUrl);

    state = reduceUploadPlaybackState(state, "playback_ready");
    expect(state).toEqual({ mode: "preview", preparing: false });
  });

  it("does not show preparing for non-preview URLs that cannot use direct-first playback", () => {
    const state = initialUploadPlaybackState(false);
    expect(uploadPlaybackUrl("/custom/video.mp4", state, null)).toBe("/custom/video.mp4");
    expect(state).toEqual({ mode: "preview", preparing: false });
  });
});
