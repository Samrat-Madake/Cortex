import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ChangeEvent } from "react";
import { Icon } from "../../theme/icons";
import { tokens } from "../../theme/tokens";
import type { DashboardSession } from "../../session";
import { dashboardAuthHeaders, withDashboardQuery } from "../../session";

interface VideoItem {
  video_id: string;
  name: string;
  size_mb: number;
  source: "upload" | "fixture";
  updated_at?: number;
  duration_sec?: number;
  tags?: string[];
}

interface VideoSelectorProps {
  open: boolean;
  onClose: () => void;
  onAnalysisStarted?: (cameraId: string) => void;
  session: DashboardSession;
}

const VIDEO_ACCEPT = ".mp4,.avi,.mkv,.mov,.webm,.mpg,.mpeg,.flv,.ts";
const PREVIEW_CACHE_VERSION = "browser-h264-v2";
const VIDEO_WINDOW_SIZE = 5;
const VIDEO_ROW_HEIGHT = 56;
const VIDEO_ROW_GAP = 8;

async function fetchVideos(session: DashboardSession): Promise<VideoItem[]> {
  const resp = await fetch(withDashboardQuery("/api/videos", session), { headers: dashboardAuthHeaders(session) });
  const data = await resp.json() as { videos?: VideoItem[]; error?: string };
  if (!resp.ok) throw new Error(data.error ?? `GET /api/videos failed: ${resp.status}`);
  return sortVideos(data.videos ?? []);
}

function sortVideos(items: VideoItem[]): VideoItem[] {
  return [...items].sort((a, b) => {
    if (a.source !== b.source) return a.source === "upload" ? -1 : 1;
    if (a.source === "upload") {
      const byTime = (b.updated_at ?? 0) - (a.updated_at ?? 0);
      if (byTime !== 0) return byTime;
    }
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  });
}

function sourceLabel(video: VideoItem): string {
  return video.source === "fixture" ? "public" : "upload";
}

function formatVideoDuration(durationSec?: number): string | null {
  if (typeof durationSec !== "number" || !Number.isFinite(durationSec) || durationSec <= 0) return null;
  const totalSeconds = Math.round(durationSec);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function videoMetaText(video: VideoItem): string {
  const duration = formatVideoDuration(video.duration_sec);
  const parts = duration ? [duration] : [];
  parts.push(`${video.size_mb} MB`);
  if (!duration) parts.unshift(sourceLabel(video));
  return parts.join(" · ");
}

async function uploadVideo(file: File, session: DashboardSession): Promise<VideoItem> {
  const form = new FormData();
  form.append("file", file);
  const resp = await fetch("/api/videos/upload", { method: "POST", headers: dashboardAuthHeaders(session), body: form });
  const data = await resp.json() as { video?: VideoItem; error?: string };
  if (!resp.ok || !data.video) throw new Error(data.error ?? `Upload failed: ${resp.status}`);
  return data.video;
}

async function deleteVideo(videoId: string, session: DashboardSession): Promise<void> {
  const resp = await fetch("/api/videos/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...dashboardAuthHeaders(session) },
    body: JSON.stringify({ video_id: videoId, session_id: session.sessionId, user_id: session.userId }),
  });
  const data = await resp.json() as { error?: string };
  if (!resp.ok) throw new Error(data.error ?? `Delete failed: ${resp.status}`);
}

type LocalFilePacing = "fast" | "realtime";

async function startAnalysis(
  videoId: string,
  session: DashboardSession,
  semanticContextInit?: string,
  localFilePacing: LocalFilePacing = "fast",
): Promise<{
  ok?: boolean;
  camera_id?: string;
  warnings?: string[];
  completed?: boolean;
  error?: string;
}> {
  const resp = await fetch("/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...dashboardAuthHeaders(session) },
    body: JSON.stringify({
      video_id: videoId,
      session_id: session.sessionId,
      user_id: session.userId,
      local_file_pacing: localFilePacing,
      ...(semanticContextInit?.trim() ? { source_context: semanticContextInit.trim() } : {}),
    }),
  });
  const data = await resp.json() as { ok?: boolean; camera_id?: string; warnings?: string[]; completed?: boolean; error?: string };
  if (!resp.ok || !data.ok) {
    const fallback = resp.status === 409 ? "Another analysis is already running." : `Analysis failed: ${resp.status}`;
    throw new Error(data.error ?? fallback);
  }
  return data;
}

function previewUrlFor(video: VideoItem, mode: "preview" | "file", session: DashboardSession): string {
  const endpoint = mode === "preview" ? "/api/videos/preview" : "/api/videos/file";
  // Version the URL so browsers do not reuse older bad probe/cache responses.
  const cacheKey = `${PREVIEW_CACHE_VERSION}:${video.name}:${video.size_mb}`;
  return withDashboardQuery(`${endpoint}?video_id=${encodeURIComponent(video.video_id)}&v=${encodeURIComponent(cacheKey)}`, session);
}

function thumbnailUrlFor(video: VideoItem, session: DashboardSession): string {
  const cacheKey = `${PREVIEW_CACHE_VERSION}:${video.name}:${video.size_mb}`;
  return withDashboardQuery(`/api/videos/thumbnail?video_id=${encodeURIComponent(video.video_id)}&v=${encodeURIComponent(cacheKey)}`, session);
}

export function VideoSelector({ open, onClose, onAnalysisStarted, session }: VideoSelectorProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [videos, setVideos] = useState<VideoItem[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [previewMode, setPreviewMode] = useState<"file" | "preview">("file");
  const [selectedVideoReady, setSelectedVideoReady] = useState(false);
  const [backgroundInfo, setBackgroundInfo] = useState("");
  const [simulateRealtime, setSimulateRealtime] = useState(false);
  const [message, setMessage] = useState<{ type: "error" | "info" | "success"; text: string } | null>(null);
  const selectedVideo = useMemo(() => videos.find((video) => video.video_id === selected), [selected, videos]);
  const uploadedVideos = useMemo(() => videos.filter((video) => video.source === "upload"), [videos]);
  const publicVideos = useMemo(() => videos.filter((video) => video.source === "fixture"), [videos]);
  const selectedPreviewUrl = selectedVideo ? previewUrlFor(selectedVideo, previewMode, session) : "";
  const selectedThumbnailUrl = selectedVideo ? thumbnailUrlFor(selectedVideo, session) : "";

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setMessage(null);
    setBackgroundInfo("");
    fetchVideos(session)
      .then((items) => {
        setVideos(items);
        setSelected((prev) => items.some((item) => item.video_id === prev) ? prev : items[0]?.video_id ?? "");
      })
      .catch((err) => setMessage({ type: "error", text: err instanceof Error ? err.message : "Failed to load videos" }))
      .finally(() => setLoading(false));
  }, [open, session]);

  useEffect(() => {
    if (!open) return;
    if (videos.length === 0) {
      if (selected) setSelected("");
      return;
    }
    if (!videos.some((video) => video.video_id === selected)) {
      setSelected(videos[0]?.video_id ?? "");
    }
  }, [open, selected, videos]);

  useEffect(() => {
    setPreviewMode("file");
    setSelectedVideoReady(false);
  }, [selected]);

  useEffect(() => {
    setSelectedVideoReady(false);
  }, [previewMode]);

  if (!open) return null;

  const handleUpload = async (file: File) => {
    if (!file) return;
    setUploading(true);
    setMessage({ type: "info", text: `Uploading ${file.name}...` });
    try {
      const uploaded = await uploadVideo(file, session);
      const next = await fetchVideos(session);
      setVideos(next);
      setSelected(uploaded.video_id);
      setMessage({ type: "success", text: `Uploaded ${uploaded.name}` });
    } catch (err) {
      setMessage({ type: "error", text: err instanceof Error ? err.message : "Upload failed" });
    } finally {
      setUploading(false);
    }
  };

  const handleFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) void handleUpload(file);
  };

  const handleDelete = async (video: VideoItem) => {
    if (video.source !== "upload" || deleting) return;
    const ok = window.confirm(`Delete uploaded video "${video.name}"?\n\nThis removes the uploaded file. If it has been analyzed as a source, delete it from Sources to also remove Moments, Entities, Scene Understanding, memories, and generated media.`);
    if (!ok) return;
    setDeleting(video.video_id);
    setMessage({ type: "info", text: `Deleting ${video.name}...` });
    try {
      await deleteVideo(video.video_id, session);
      const next = await fetchVideos(session);
      setVideos(next);
      setSelected((prev) => {
        if (prev !== video.video_id) return prev;
        return next[0]?.video_id ?? "";
      });
      setMessage({ type: "success", text: `Deleted ${video.name}` });
    } catch (err) {
      setMessage({ type: "error", text: err instanceof Error ? err.message : "Delete failed" });
    } finally {
      setDeleting(null);
    }
  };

  const handleStart = async () => {
    if (!selected) return;
    setStarting(true);
    setMessage({ type: "info", text: "Starting analysis..." });
    try {
      const result = await startAnalysis(selected, session, backgroundInfo, simulateRealtime ? "realtime" : "fast");
      if (result.camera_id) {
        onAnalysisStarted?.(result.camera_id);
      }
      const warningText = result.warnings?.length ? ` Warning: ${result.warnings.join(" ")}` : "";
      if (result.completed) {
        setMessage({ type: "success", text: `Analysis completed.${warningText}` });
        window.setTimeout(onClose, 1200);
        return;
      }
      if (warningText) {
        setMessage({ type: "info", text: `Analysis started.${warningText}` });
        window.setTimeout(onClose, 1200);
        return;
      }
      onClose();
    } catch (err) {
      setMessage({ type: "error", text: err instanceof Error ? err.message : "Analysis failed" });
    } finally {
      setStarting(false);
    }
  };

  const renderVideoRow = (video: VideoItem) => {
    const active = selected === video.video_id;
    return (
      <div
        key={video.video_id}
        role="button"
        tabIndex={0}
        onClick={() => setSelected(video.video_id)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setSelected(video.video_id);
          }
        }}
        style={{
          ...videoRowStyle,
          borderColor: active ? tokens.accent.base : "rgba(148,163,184,0.35)",
          background: active ? tokens.accent.soft : tokens.bg.elevated,
        }}
      >
        <span style={videoRowContentStyle}>
          <span style={videoThumbStyle}>
            <img
              src={thumbnailUrlFor(video, session)}
              alt=""
              loading="lazy"
              style={videoThumbImageStyle}
            />
          </span>
          <span style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: tokens.text.primary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {video.name}
            </span>
            <span style={videoMetaRowStyle}>
              <span style={videoMetaTextStyle}>{videoMetaText(video)}</span>
              {(video.tags ?? []).slice(0, 3).map((tag) => (
                <span key={tag} style={videoTagStyle}>{tag}</span>
              ))}
            </span>
          </span>
        </span>
        {video.source === "upload" ? (
          <button
            type="button"
            title={`Delete ${video.name}`}
            aria-label={`Delete ${video.name}`}
            onClick={(event) => {
              event.stopPropagation();
              void handleDelete(video);
            }}
            disabled={deleting === video.video_id || starting || uploading}
            style={{
              ...deleteButtonStyle,
              opacity: deleting === video.video_id ? 0.55 : 1,
              cursor: deleting === video.video_id ? "not-allowed" : "pointer",
            }}
          >
            <Icon name="trash" size={14} color="currentColor" />
          </button>
        ) : null}
      </div>
    );
  };

  const backdrop: CSSProperties = {
    position: "fixed",
    inset: 0,
    zIndex: 220,
    background: "rgba(15, 23, 42, 0.44)",
    backdropFilter: "blur(6px)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
  };
  const panel: CSSProperties = {
    width: 820,
    maxWidth: "calc(100vw - 40px)",
    maxHeight: "88vh",
    overflowY: "auto",
    borderRadius: 22,
    background: tokens.bg.surface,
    boxShadow: tokens.shadow.elevated,
    padding: 20,
    fontFamily: tokens.font.sans,
  };
  const messageColor = message?.type === "error"
    ? tokens.semantic.red
    : message?.type === "success"
      ? tokens.semantic.green
      : tokens.text.secondary;

  return (
    <div style={backdrop} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-label="Select video for analysis" style={panel}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: tokens.text.primary }}>Video analysis</div>
            <div style={{ fontSize: 12, color: tokens.text.muted }}>Choose a local video or upload a new one.</div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" style={closeButtonStyle}>X</button>
        </div>

        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const file = e.dataTransfer.files[0];
            if (file) void handleUpload(file);
          }}
          disabled={uploading}
          style={dropStyle}
        >
          {uploading ? "Uploading..." : "Drop or click to upload video"}
        </button>
        <input ref={inputRef} type="file" accept={VIDEO_ACCEPT} onChange={handleFile} style={{ display: "none" }} />

        {loading ? (
          <div style={emptyStyle}>Loading videos...</div>
        ) : videos.length === 0 ? (
          <div style={emptyStyle}>No videos found. Upload one to start analysis.</div>
        ) : (
          <>
            <div style={videoSectionHeaderStyle}>Videos</div>
            <div style={videoPickerGridStyle}>
              <section style={videoListPanelStyle} aria-label="Available videos">
                <div style={videoScrollWindowStyle}>
                  {uploadedVideos.map(renderVideoRow)}
                  {publicVideos.length > 0 ? (
                    <>
                      <div style={publicVideosDividerStyle}>
                        {uploadedVideos.length > 0 ? <div style={publicVideosLineStyle} /> : null}
                        <div style={publicVideosTextStyle}>Public test videos</div>
                      </div>
                      {publicVideos.map(renderVideoRow)}
                    </>
                  ) : null}
                </div>
              </section>

              {selectedVideo && (
                <section style={previewBoxStyle} aria-label="Selected video preview">
                  <div style={previewStageStyle}>
                    <img
                      src={selectedThumbnailUrl}
                      alt=""
                      style={previewThumbnailStyle}
                    />
                    <video
                      key={`${selectedVideo.video_id}:${previewMode}`}
                      src={selectedPreviewUrl}
                      controls
                      muted
                      playsInline
                      preload="metadata"
                      onCanPlay={() => {
                        setSelectedVideoReady(true);
                        setMessage((current) => current?.type === "error" ? null : current);
                      }}
                      onError={(event) => {
                        const code = event.currentTarget.error?.code;
                        if (previewMode === "file") {
                          setPreviewMode("preview");
                          return;
                        }
                        setMessage({ type: "error", text: `Preview failed for ${selectedVideo.name}${code ? ` (media error ${code})` : ""}` });
                      }}
                      style={{
                        ...previewVideoStyle,
                        opacity: selectedVideoReady ? 1 : 0,
                      }}
                    />
                  </div>
                  <div style={previewHintStyle}>
                    Preview only. Click Start Analysis to show this video on the Dashboard and generate Moments / Entities.
                    {" "}
                    <a
                      href={selectedPreviewUrl}
                      target="_blank"
                      rel="noreferrer"
                      style={{ color: tokens.accent.base, fontWeight: 700, textDecoration: "none" }}
                    >
                      Open video
                    </a>
                  </div>
                </section>
              )}
            </div>
          </>
        )}

        <section style={runtimeOptionsStyle}>
          <div style={runtimeOptionsDividerStyle} />
          <label style={runtimeToggleStyle}>
            <input
              type="checkbox"
              checked={simulateRealtime}
              onChange={(event) => setSimulateRealtime(event.target.checked)}
              disabled={starting || uploading}
              style={{ accentColor: tokens.accent.base, marginTop: 2 }}
            />
            <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: tokens.text.primary }}>
                Simulate real-time stream
              </span>
              <span style={{ fontSize: 11, color: tokens.text.muted, lineHeight: 1.35 }}>
                Play the upload at natural speed and analyze it like a live source. Leave off for faster analysis.
              </span>
            </span>
          </label>
          <label style={contextLabelStyle}>Background Context</label>
          <textarea
            value={backgroundInfo}
            onChange={(event) => setBackgroundInfo(event.target.value)}
            placeholder="Optional: tell the system what this video is about, where it was recorded, who may appear, and what you want it to pay attention to."
            rows={3}
            style={contextTextareaStyle}
          />
        </section>

        {message && (
          <div style={{ marginTop: 12, fontSize: 12, color: messageColor }}>
            {message.text}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
          <button type="button" onClick={onClose} style={secondaryButtonStyle}>Cancel</button>
          <button
            type="button"
            onClick={handleStart}
            disabled={!selectedVideo || starting || uploading}
            style={{
              ...primaryButtonStyle,
              opacity: !selectedVideo || starting || uploading ? 0.55 : 1,
              cursor: !selectedVideo || starting || uploading ? "not-allowed" : "pointer",
            }}
          >
            {starting ? "Starting..." : "Start Analysis"}
          </button>
        </div>
      </div>
    </div>
  );
}

const closeButtonStyle: CSSProperties = {
  border: "none",
  background: "transparent",
  color: tokens.text.muted,
  cursor: "pointer",
  fontSize: 16,
};

const emptyStyle: CSSProperties = {
  border: "1px dashed rgba(148,163,184,0.45)",
  borderRadius: tokens.radius.md,
  marginTop: 12,
  padding: 18,
  fontSize: 12,
  color: tokens.text.muted,
  textAlign: "center",
};

const pickerHeight = VIDEO_WINDOW_SIZE * VIDEO_ROW_HEIGHT + (VIDEO_WINDOW_SIZE - 1) * VIDEO_ROW_GAP;

const videoPickerGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
  alignItems: "stretch",
  gap: 14,
  marginTop: 8,
};

const videoListPanelStyle: CSSProperties = {
  minWidth: 0,
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

const videoSectionHeaderStyle: CSSProperties = {
  marginTop: 14,
  fontSize: 11,
  fontWeight: 800,
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  color: tokens.text.muted,
};

const runtimeOptionsStyle: CSSProperties = {
  marginTop: 14,
  display: "flex",
  flexDirection: "column",
  gap: 10,
};

const runtimeOptionsDividerStyle: CSSProperties = {
  height: 1,
  background: "rgba(148,163,184,0.22)",
};

const contextLabelStyle: CSSProperties = {
  display: "block",
  marginTop: 2,
  marginBottom: 6,
  fontSize: 12,
  fontWeight: 700,
  color: tokens.text.secondary,
};

const runtimeToggleStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 10,
  padding: "0 2px",
  cursor: "pointer",
  userSelect: "none",
};

const videoRowStyle: CSSProperties = {
  width: "100%",
  height: VIDEO_ROW_HEIGHT,
  boxSizing: "border-box",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 10,
  border: "1.5px solid",
  borderRadius: tokens.radius.md,
  padding: "8px 10px",
  cursor: "pointer",
  fontFamily: tokens.font.sans,
  textAlign: "left",
};

const videoRowContentStyle: CSSProperties = {
  minWidth: 0,
  flex: "1 1 auto",
  display: "flex",
  alignItems: "center",
  gap: 9,
};

const videoThumbStyle: CSSProperties = {
  flex: "0 0 auto",
  width: 52,
  height: 38,
  borderRadius: tokens.radius.sm,
  overflow: "hidden",
  background: tokens.bg.videoFrame,
  boxShadow: "0 0 0 1px rgba(31,45,71,0.08)",
};

const videoThumbImageStyle: CSSProperties = {
  width: "100%",
  height: "100%",
  display: "block",
  objectFit: "cover",
};

const videoMetaRowStyle: CSSProperties = {
  minWidth: 0,
  display: "flex",
  alignItems: "center",
  gap: 5,
  overflow: "hidden",
  color: tokens.text.muted,
  fontSize: 11,
};

const videoMetaTextStyle: CSSProperties = {
  flex: "0 1 auto",
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const videoTagStyle: CSSProperties = {
  flex: "0 0 auto",
  maxWidth: 72,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  borderRadius: tokens.radius.pill,
  padding: "1px 6px",
  background: "rgba(148,163,184,0.14)",
  color: tokens.text.secondary,
  fontSize: 10,
  lineHeight: 1.35,
};

const videoScrollWindowStyle: CSSProperties = {
  height: pickerHeight,
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
  gap: VIDEO_ROW_GAP,
  paddingRight: 2,
};

const publicVideosDividerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 7,
  padding: "2px 0 0",
};

const publicVideosLineStyle: CSSProperties = {
  height: 1,
  background: "rgba(148,163,184,0.22)",
};

const publicVideosTextStyle: CSSProperties = {
  fontSize: 11,
  color: tokens.text.muted,
  lineHeight: 1.2,
};

const deleteButtonStyle: CSSProperties = {
  flex: "0 0 auto",
  width: 28,
  height: 28,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  border: "1px solid rgba(148,163,184,0.32)",
  borderRadius: "50%",
  padding: 0,
  background: "rgba(255,255,255,0.75)",
  color: tokens.text.faint,
  cursor: "pointer",
  fontFamily: tokens.font.sans,
};

const previewBoxStyle: CSSProperties = {
  height: pickerHeight,
  maxHeight: pickerHeight,
  minHeight: pickerHeight,
  borderRadius: tokens.radius.md,
  overflow: "hidden",
  background: tokens.bg.videoFrame,
  boxShadow: tokens.shadow.border,
  display: "flex",
  flexDirection: "column",
};

const previewStageStyle: CSSProperties = {
  position: "relative",
  flex: 1,
  minHeight: 0,
  overflow: "hidden",
  background: tokens.bg.videoFrame,
};

const previewThumbnailStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  width: "100%",
  height: "100%",
  objectFit: "contain",
  background: tokens.bg.videoFrame,
};

const previewVideoStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  width: "100%",
  height: "100%",
  display: "block",
  objectFit: "contain",
  background: tokens.bg.videoFrame,
  transition: "opacity 160ms ease",
};

const previewHintStyle: CSSProperties = {
  padding: "8px 10px",
  background: tokens.bg.inset,
  color: tokens.text.muted,
  fontSize: 11,
  lineHeight: 1.4,
};

const contextTextareaStyle: CSSProperties = {
  width: "100%",
  resize: "vertical",
  minHeight: 74,
  boxSizing: "border-box",
  border: "1px solid rgba(148,163,184,0.35)",
  borderRadius: tokens.radius.md,
  padding: "9px 10px",
  background: tokens.bg.elevated,
  color: tokens.text.primary,
  fontFamily: tokens.font.sans,
  fontSize: 12,
  lineHeight: 1.45,
  outline: "none",
};

const dropStyle: CSSProperties = {
  width: "100%",
  marginTop: 0,
  padding: "16px 12px",
  borderRadius: tokens.radius.md,
  border: `1.5px dashed ${tokens.accent.border}`,
  background: tokens.bg.inset,
  color: tokens.accent.base,
  cursor: "pointer",
  fontFamily: tokens.font.sans,
  fontSize: 12,
  fontWeight: 700,
};

const secondaryButtonStyle: CSSProperties = {
  border: "none",
  borderRadius: tokens.radius.pill,
  padding: "8px 14px",
  background: tokens.bg.elevated,
  color: tokens.text.secondary,
  cursor: "pointer",
  fontFamily: tokens.font.sans,
};

const primaryButtonStyle: CSSProperties = {
  border: "none",
  borderRadius: tokens.radius.pill,
  padding: "8px 16px",
  background: tokens.accent.base,
  color: "#fff",
  cursor: "pointer",
  fontFamily: tokens.font.sans,
  fontWeight: 700,
};
