import { useEffect, useRef, useState } from "react";
import type { DashboardSession } from "../../session";
import { withDashboardQuery } from "../../session";
import { Icon } from "../../theme/icons";
import { tokens, getCameraColor } from "../../theme/tokens";
import {
  DIRECT_PLAYBACK_FALLBACK_MS,
  directFileUrlForPreview,
  initialUploadPlaybackState,
  reduceUploadPlaybackState,
  uploadPlaybackUrl,
} from "./liveVideoPlayback";

interface LiveVideoProps {
  cameraId: string | null;
  session: DashboardSession;
  summary?: string;
  mode?: string;
  previewUrl?: string;
  autoplayToken?: number;
  sourceStatus?: "active" | "reconnecting" | "unavailable" | "waiting" | "stopped";
  sourceInput?: string;
  sourceProtocol?: string;
  onExpand?: () => void;
}

const SHOW_HAPPENING_NOW_OVERLAY = false;

/**
 * Light-themed live video player for the sidebar.
 *
 * Renders uploads with a normal video element and live sources through the
 * Dashboard-controlled MJPEG proxy. The browser never talks directly to go2rtc,
 * so public demo deployments can keep go2rtc private and enforce Dashboard
 * session/source scoping at the HTTP boundary.
 */
export function LiveVideo({
  cameraId,
  session,
  summary,
  mode,
  previewUrl,
  autoplayToken,
  sourceStatus = "active",
  onExpand,
}: LiveVideoProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [clockLabel, setClockLabel] = useState(() => formatClock(Date.now()));
  const [streamActive, setStreamActive] = useState(false);
  const [uploadPlayback, setUploadPlayback] = useState(() => initialUploadPlaybackState(false));
  const directPreviewUrl = previewUrl
    ? directFileUrlForPreview(previewUrl, typeof window === "undefined" ? undefined : window.location.href)
    : null;
  const previewPlaybackUrl = previewUrl ? uploadPlaybackUrl(previewUrl, uploadPlayback, directPreviewUrl) : null;
  const activeUploadMode = previewPlaybackUrl && previewPlaybackUrl === directPreviewUrl ? "direct" : "preview";

  useEffect(() => {
    if (!cameraId || previewUrl) return;
    const id = window.setInterval(() => setClockLabel(formatClock(Date.now())), 1000);
    return () => window.clearInterval(id);
  }, [cameraId, previewUrl]);

  useEffect(() => {
    setUploadPlayback(initialUploadPlaybackState(Boolean(previewUrl && directPreviewUrl)));
  }, [previewUrl, directPreviewUrl]);

  useEffect(() => {
    if (!previewPlaybackUrl || autoplayToken === undefined) return;
    const video = videoRef.current;
    if (!video) return;
    video.muted = true;
    video.load();
    void video.play().catch(() => {
      // Browsers may still block autoplay in edge cases; the controls remain visible.
    });
  }, [previewPlaybackUrl, autoplayToken]);

  useEffect(() => {
    if (!previewPlaybackUrl) return;
    const video = videoRef.current;
    if (!video) return;
    const markPlayable = () => {
      setUploadPlayback((current) => reduceUploadPlaybackState(current, "playback_ready"));
    };
    const fallback = () => {
      setUploadPlayback((current) => reduceUploadPlaybackState(
        current,
        activeUploadMode === "direct" ? "direct_unavailable" : "playback_failed",
      ));
    };
    video.addEventListener("loadeddata", markPlayable);
    video.addEventListener("canplay", markPlayable);
    video.addEventListener("error", fallback);
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) markPlayable();
    return () => {
      video.removeEventListener("loadeddata", markPlayable);
      video.removeEventListener("canplay", markPlayable);
      video.removeEventListener("error", fallback);
    };
  }, [previewPlaybackUrl, activeUploadMode]);

  useEffect(() => {
    if (!previewPlaybackUrl || activeUploadMode !== "direct") return;
    const timer = window.setTimeout(() => {
      const video = videoRef.current;
      if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
        setUploadPlayback((current) => reduceUploadPlaybackState(current, "direct_unavailable"));
      }
    }, DIRECT_PLAYBACK_FALLBACK_MS);
    return () => window.clearTimeout(timer);
  }, [previewPlaybackUrl, activeUploadMode]);

  const liveStreamUrl = cameraId
    ? withDashboardQuery(`/api/live/stream.mp4?src=${encodeURIComponent(cameraId)}`, session)
    : null;

  useEffect(() => {
    if (previewUrl || !liveStreamUrl || !streamActive) return;
    const video = videoRef.current;
    if (!video) return;
    video.muted = true;
    video.load();
    void video.play().catch(() => {
      // Keep the live player mounted; the browser will retry once data arrives
      // or the user interacts with the page.
    });
  }, [previewUrl, liveStreamUrl, streamActive]);

  useEffect(() => {
    if (!cameraId || previewUrl) {
      setStreamActive(true);
      return;
    }
    let cancelled = false;
    setStreamActive(false);
    const check = async () => {
      try {
        const res = await fetch(
          withDashboardQuery(`/api/live/status?src=${encodeURIComponent(cameraId)}`, session),
          { cache: "no-store" },
        );
        const data = res.ok ? await res.json() as { active?: unknown } : null;
        if (!cancelled) setStreamActive(data?.active === true);
      } catch {
        if (!cancelled) setStreamActive(false);
      }
    };
    void check();
    const id = window.setInterval(() => void check(), 3000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [cameraId, previewUrl, session]);

  const cameraColor = cameraId ? getCameraColor(cameraId) : tokens.text.muted;
  const playerLoading = !previewUrl && Boolean(cameraId) && !liveStreamUrl;
  const waiting = !previewUrl && cameraId && !streamActive && (playerLoading || sourceStatus === "waiting");
  const stopped = !previewUrl && cameraId && !streamActive && !waiting && sourceStatus === "stopped";
  const unavailable = !previewUrl && cameraId && !streamActive && !waiting && !stopped && sourceStatus === "unavailable";
  const connecting = !previewUrl && cameraId && !waiting && !stopped && !unavailable && !streamActive;
  const showHealthWarning = !previewUrl && cameraId && !waiting && !stopped && !unavailable && sourceStatus === "reconnecting";
  const showLivePlayer = Boolean(liveStreamUrl && !stopped && !waiting);
  const sourceBadge = previewUrl
    ? "Uploaded"
    : waiting
      ? "Waiting"
    : stopped
      ? "Stopped"
    : sourceStatus === "reconnecting"
      ? "Reconnecting"
      : sourceStatus === "unavailable"
        ? "Offline"
        : cameraId
          ? "Live"
          : null;

  return (
    <>
      <div
        style={{
          borderRadius: tokens.radius.lg,
          overflow: "hidden",
          background:
            "linear-gradient(140deg, rgba(14,22,38,0.96), rgba(5,9,18,1) 42%, rgba(12,18,31,1))",
          position: "relative",
          boxShadow: "0 18px 40px -26px rgba(3,9,24,0.85), 0 0 0 1px rgba(255,255,255,0.08)",
        }}
        className="vid-wrap"
      >
        {/* Top overlay: live badge + camera label */}
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            zIndex: 1,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "10px 12px",
            pointerEvents: "none",
          }}
        >
          {sourceBadge && (
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                background: previewUrl
                  ? "rgba(47,109,246,0.85)"
                  : sourceBadge === "Live"
                    ? "rgba(16,185,129,0.88)"
                    : sourceBadge === "Stopped"
                      ? "rgba(71,85,105,0.88)"
                      : sourceBadge === "Offline"
                        ? "rgba(239,68,68,0.88)"
                        : "rgba(245,158,11,0.88)",
                color: "#fff",
                padding: "5px 10px",
                borderRadius: tokens.radius.pill,
                fontSize: 10,
                fontWeight: 800,
                letterSpacing: "0.04em",
                backdropFilter: "blur(12px)",
              }}
            >
              <span
                style={{
                  width: 5,
                  height: 5,
                  background: "#fff",
                  borderRadius: "50%",
                  display: "inline-block",
                }}
              />
              {sourceBadge}
            </div>
          )}
          <div style={{ display: "flex", gap: 6 }}>
            {mode && (
              <div
                style={{
                  background: "rgba(255,255,255,0.12)",
                  color: "rgba(255,255,255,0.78)",
                  padding: "5px 10px",
                  borderRadius: tokens.radius.pill,
                  fontSize: 10,
                  fontWeight: 700,
                  backdropFilter: "blur(12px)",
                }}
              >
                {mode}
              </div>
            )}
            <div
              style={{
                background: "rgba(255,255,255,0.12)",
                color: cameraColor,
                padding: "5px 10px",
                borderRadius: tokens.radius.pill,
                fontSize: 10,
                fontWeight: 800,
                backdropFilter: "blur(12px)",
              }}
            >
              {cameraId ?? "No camera"}
            </div>
          </div>
        </div>

        {/* Dedicated expand affordance — a real <button> so the expand action
            has one focusable, correctly-announced control. The iframe below
            remains fully interactive. */}
        {onExpand && (
          <button
            type="button"
            onClick={onExpand}
            aria-label="Expand"
            style={{
              position: "absolute",
              top: 8,
              right: 8,
              zIndex: 2,
              width: 24,
              height: 24,
              padding: 0,
              border: "none",
              borderRadius: tokens.radius.sm,
              background: "rgba(0,0,0,0.45)",
              color: "rgba(255,255,255,0.85)",
              cursor: "pointer",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              backdropFilter: "blur(12px)",
              opacity: 0,
              transition: "opacity 0.2s",
            }}
            className="vid-expand-btn"
          >
            <Icon name="expand" size={14} color="rgba(255,255,255,0.85)" />
          </button>
        )}

        {/* 16:10 video frame */}
        <div
          style={{
            width: "100%",
            aspectRatio: "16 / 9",
            background: tokens.bg.videoPlaceholder,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            overflow: "hidden",
          }}
        >
          {previewUrl ? (
            <>
              <video
                ref={videoRef}
                key={previewPlaybackUrl ?? previewUrl}
                src={previewPlaybackUrl ?? previewUrl}
                controls
                muted
                playsInline
                style={{
                  width: "100%",
                  height: "100%",
                  objectFit: "contain",
                  background: tokens.bg.videoFrame,
                  display: "block",
                }}
              />
              {uploadPlayback.preparing && (
                <span
                  style={{
                    position: "absolute",
                    left: 10,
                    bottom: 10,
                    zIndex: 1,
                    padding: "5px 9px",
                    borderRadius: tokens.radius.pill,
                    background: "rgba(15,23,42,0.72)",
                    color: "#fff",
                    fontSize: 10,
                    fontWeight: 700,
                  }}
                >
                  Preparing playback
                </span>
              )}
            </>
          ) : showLivePlayer ? (
            <>
              <video
                ref={videoRef}
                key={liveStreamUrl}
                src={liveStreamUrl ?? undefined}
                autoPlay
                muted
                playsInline
                controls={false}
                style={{
                  width: "100%",
                  height: "100%",
                  background: tokens.bg.videoFrame,
                  display: "block",
                  objectFit: "contain",
                }}
              />
              {showHealthWarning && (
                <span
                  style={{
                    position: "absolute",
                    left: 10,
                    bottom: 10,
                    zIndex: 1,
                    padding: "5px 9px",
                    borderRadius: tokens.radius.pill,
                    background: "rgba(245,158,11,0.88)",
                    color: "#fff",
                    fontSize: 10,
                    fontWeight: 700,
                  }}
                >
                  Reconnecting
                </span>
              )}
              {connecting && (
                <span
                  style={{
                    position: "absolute",
                    left: 10,
                    bottom: 10,
                    zIndex: 1,
                    padding: "5px 9px",
                    borderRadius: tokens.radius.pill,
                    background: "rgba(15,23,42,0.72)",
                    color: "#fff",
                    fontSize: 10,
                    fontWeight: 700,
                  }}
                >
                  Connecting
                </span>
              )}
            </>
          ) : stopped ? (
            <div style={{ color: "rgba(255,255,255,0.78)", fontSize: 12, textAlign: "center", padding: 18 }}>
              Watch stopped
              <div style={{ marginTop: 5, color: "rgba(255,255,255,0.52)", fontSize: 11 }}>
                Use Start on the source card to resume analysis.
              </div>
            </div>
          ) : waiting || connecting ? (
            <div style={{ color: "rgba(255,255,255,0.78)", fontSize: 12, textAlign: "center", padding: 18 }}>
              {connecting ? "Connecting live stream" : "Waiting for WebRTC stream"}
              <div style={{ marginTop: 5, color: "rgba(255,255,255,0.52)", fontSize: 11 }}>
                {connecting
                  ? "Preparing the video player after the first frame arrives."
                  : "Keep the source page open, or reopen the link / QR to resume."}
              </div>
            </div>
          ) : unavailable ? (
            <div style={{ color: "rgba(255,255,255,0.78)", fontSize: 12, textAlign: "center", padding: 18 }}>
              Live stream unavailable
              <div style={{ marginTop: 5, color: "rgba(255,255,255,0.52)", fontSize: 11 }}>
                Check the source connection, then add the stream again.
              </div>
            </div>
          ) : (
            <span style={{ color: tokens.text.muted, fontSize: 12 }}>No camera selected</span>
          )}
        </div>

        {/* Hover hint — purely decorative span, not a semantic button. */}
        {onExpand && (
          <span
            className="expand-h"
            style={{
              position: "absolute",
              bottom: 8,
              right: 8,
              background: "rgba(0,0,0,0.45)",
              color: "rgba(255,255,255,0.7)",
              padding: "2px 8px",
              borderRadius: tokens.radius.sm,
              fontSize: 9,
              opacity: 0,
              transition: "opacity 0.2s",
              pointerEvents: "none",
            }}
          >
            Click to expand
          </span>
        )}

        {!previewUrl && cameraId && (
          <time
            dateTime={clockLabel}
            aria-label={`Current live time ${clockLabel}`}
            style={{
              position: "absolute",
              right: 10,
              bottom: 10,
              zIndex: 1,
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "5px 9px",
              borderRadius: tokens.radius.pill,
              background: "rgba(0,0,0,0.48)",
              color: "rgba(255,255,255,0.88)",
              fontSize: 10,
              fontWeight: 500,
              letterSpacing: "0.04em",
              backdropFilter: "blur(12px)",
              pointerEvents: "none",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {clockLabel}
          </time>
        )}

        {SHOW_HAPPENING_NOW_OVERLAY && summary && (
          <div
            aria-label="Happening now"
            style={{
              position: "absolute",
              left: 18,
              right: 18,
              bottom: !previewUrl && cameraId ? 36 : 14,
              zIndex: 1,
              display: "flex",
              justifyContent: "center",
              pointerEvents: "none",
            }}
          >
            <div
              style={{
                maxWidth: "92%",
                padding: "5px 10px",
                borderRadius: tokens.radius.md,
                background: "rgba(0,0,0,0.62)",
                color: "rgba(255,255,255,0.94)",
                fontSize: 12,
                lineHeight: 1.42,
                textAlign: "center",
                boxShadow: "0 10px 26px rgba(0,0,0,0.28)",
                backdropFilter: "blur(10px)",
                display: "-webkit-box",
                WebkitLineClamp: 2,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
              }}
            >
              {summary}
            </div>
          </div>
        )}

        <style>{`
          .vid-wrap:hover .expand-h { opacity: 1; }
          .vid-wrap:hover .vid-expand-btn,
          .vid-expand-btn:focus-visible { opacity: 1; }
        `}</style>
      </div>
    </>
  );
}

function formatClock(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}
