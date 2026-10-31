export type UploadPlaybackMode = "direct" | "preview";

export interface UploadPlaybackState {
  mode: UploadPlaybackMode;
  preparing: boolean;
}

export type UploadPlaybackEvent = "direct_unavailable" | "playback_ready" | "playback_failed";

export const DIRECT_PLAYBACK_FALLBACK_MS = 8_000;

export function initialUploadPlaybackState(hasDirectUrl: boolean): UploadPlaybackState {
  return { mode: hasDirectUrl ? "direct" : "preview", preparing: false };
}

export function reduceUploadPlaybackState(
  state: UploadPlaybackState,
  event: UploadPlaybackEvent,
): UploadPlaybackState {
  if (event === "direct_unavailable") {
    return state.mode === "direct"
      ? { mode: "preview", preparing: true }
      : state;
  }
  if (event === "playback_ready") {
    return state.preparing ? { ...state, preparing: false } : state;
  }
  return state.preparing ? { ...state, preparing: false } : state;
}

export function directFileUrlForPreview(previewUrl: string, baseHref?: string): string | null {
  try {
    const url = new URL(previewUrl, baseHref ?? "http://localhost");
    if (!url.pathname.endsWith("/api/videos/preview")) return null;
    url.pathname = url.pathname.replace(/\/api\/videos\/preview$/, "/api/videos/file");
    if (previewUrl.startsWith("http://") || previewUrl.startsWith("https://")) return url.toString();
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

export function uploadPlaybackUrl(
  previewUrl: string,
  state: UploadPlaybackState,
  directUrl: string | null,
): string {
  return state.mode === "direct" && directUrl ? directUrl : previewUrl;
}
