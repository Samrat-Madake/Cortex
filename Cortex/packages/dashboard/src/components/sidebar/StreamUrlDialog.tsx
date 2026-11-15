import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { CSSProperties, FormEvent, MouseEvent as ReactMouseEvent } from "react";
import { tokens } from "../../theme/tokens";
import type { DashboardSession } from "../../session";
import { dashboardAuthHeaders } from "../../session";

/** Dashboard talks to DashboardServer orchestration APIs, NOT directly to go2rtc. */

interface StreamUrlDialogProps {
  open: boolean;
  onClose: () => void;
  hostname: string;
  session: DashboardSession;
  onStreamStarted?: (sourceId: string) => void;
}

interface PhoneSetup {
  node_url?: string;
  qr_data_url?: string;
  message?: string;
}

/** Loose validation — must start with a recognised scheme. */
function isValidStreamUrl(url: string): boolean {
  return /^(rtsp|https?):\/\/.+/.test(url.trim());
}

/**
 * Modal dialog for adding a new stream source and starting analysis.
 *
 * POSTs to the DashboardServer `/api/streams/analyze` endpoint, which composes
 * existing cam `add_source` and `watch` actions without changing their
 * standalone semantics.
 */
export function StreamUrlDialog({ open, onClose, hostname, session, onStreamStarted }: StreamUrlDialogProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const urlRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  const [sourceKind, setSourceKind] = useState<"url" | "web" | "qr">("url");
  const [streamUrl, setStreamUrl] = useState("");
  const [streamName, setStreamName] = useState("");
  const [mode, setMode] = useState<"stream" | "event">("stream");
  const [fps, setFps] = useState("1");
  const [duration, setDuration] = useState("");
  const [backgroundInfo, setBackgroundInfo] = useState("");
  const [phoneSetup, setPhoneSetup] = useState<PhoneSetup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitMessage, setSubmitMessage] = useState<string | null>(null);

  // Reset form state when dialog opens.
  useEffect(() => {
    if (open) {
      setSourceKind("url");
      setStreamUrl("");
      setStreamName("");
      setMode("stream");
      setFps("1");
      setDuration("");
      setBackgroundInfo("");
      setPhoneSetup(null);
      setError(null);
      setSubmitting(false);
      setSubmitMessage(null);
    }
  }, [open]);

  // Focus the first input when opening.
  useEffect(() => {
    if (open) {
      // Small delay so the DOM has rendered the input.
      requestAnimationFrame(() => urlRef.current?.focus());
    }
  }, [open]);

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const canSubmit =
    (sourceKind !== "url" || streamUrl.trim().length > 0) &&
    streamName.trim().length > 0 &&
    (sourceKind !== "url" || isValidStreamUrl(streamUrl)) &&
    !submitting;

  const handleSubmit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (!canSubmit) return;

      const url = streamUrl.trim();
      const name = streamName.trim();
      const fpsNumber = Number.parseFloat(fps);
      const durationNumber = duration.trim() ? Number.parseFloat(duration) : undefined;
      const isPhone = sourceKind !== "url";
      const semanticContextInit = backgroundInfo.trim();

      if (!isPhone && !isValidStreamUrl(url)) {
        setError("URL must start with rtsp://, http://, or https://");
        return;
      }
      if (!Number.isFinite(fpsNumber) || fpsNumber <= 0) {
        setError("FPS must be a positive number");
        return;
      }
      if (durationNumber !== undefined && (!Number.isFinite(durationNumber) || durationNumber <= 0)) {
        setError("Duration must be empty or a positive number of seconds");
        return;
      }

      setError(null);
      setSubmitting(true);
      setSubmitMessage(isPhone && !phoneSetup
        ? "Preparing camera link..."
        : isPhone
          ? "Connecting camera stream..."
          : "Starting stream analysis...");

      try {
        const port = window.location.port || "3210";
        const endpoint = `http://${hostname}:${port}/api/streams/analyze`;
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...dashboardAuthHeaders(session) },
          body: JSON.stringify({
            ...(isPhone
              ? (phoneSetup ? {} : { source: "phone", defer_watch: true })
              : { source: url }),
            name,
            mode,
            fps: fpsNumber,
            session_id: session.sessionId,
            user_id: session.userId,
            ...(durationNumber !== undefined ? { duration: durationNumber } : {}),
            ...(semanticContextInit && (!isPhone || phoneSetup) ? { source_context: semanticContextInit } : {}),
          }),
        });

        if (!res.ok) {
          const body = await res.text().catch(() => "");
          let message = body || `stream watch returned ${res.status}`;
          try {
            const parsed = JSON.parse(body) as { error?: unknown };
            if (typeof parsed.error === "string" && parsed.error.trim()) message = parsed.error.trim();
          } catch {
            // Keep the raw response body when it is not JSON.
          }
          throw new Error(message);
        }

        const data = await res.json().catch(() => ({})) as {
          source_id?: string;
          camera_id?: string;
          phone_setup?: PhoneSetup;
        };
        const sourceId = typeof data.source_id === "string" && data.source_id.trim()
          ? data.source_id.trim()
          : typeof data.camera_id === "string" && data.camera_id.trim()
            ? data.camera_id.trim()
            : name;
        if (sourceId) onStreamStarted?.(sourceId);

        if (isPhone && !phoneSetup) {
          setPhoneSetup(data.phone_setup ?? {});
          setError(null);
          setSubmitMessage("Open the camera link, allow camera access, then start analysis.");
          return;
        }

        onClose();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(`Failed to start stream analysis: ${msg}`);
      } finally {
        setSubmitting(false);
      }
    },
    [canSubmit, streamUrl, streamName, fps, duration, mode, sourceKind, phoneSetup, backgroundInfo, hostname, onClose, onStreamStarted, session],
  );

  if (!open) return null;

  const handleBackdropClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose();
  };

  const overlayStyle: CSSProperties = {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.4)",
    backdropFilter: "blur(4px)",
    WebkitBackdropFilter: "blur(4px)",
    zIndex: 200,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontFamily: tokens.font.sans,
  };

  const panelStyle: CSSProperties = {
    background: tokens.bg.surface,
    borderRadius: tokens.radius.lg,
    padding: 24,
    width: "min(560px, calc(100vw - 32px))",
    boxShadow: tokens.shadow.elevated,
    outline: "none",
  };

  const inputStyle: CSSProperties = {
    width: "100%",
    padding: "8px 12px",
    fontSize: 13,
    fontFamily: tokens.font.sans,
    border: `1px solid ${tokens.text.faint}`,
    borderRadius: tokens.radius.md,
    background: tokens.bg.elevated,
    color: tokens.text.primary,
    outline: "none",
    boxSizing: "border-box",
  };

  const labelStyle: CSSProperties = {
    fontSize: 12,
    fontWeight: 600,
    color: tokens.text.secondary,
    marginBottom: 6,
    display: "block",
  };

  return (
    <div style={overlayStyle} onClick={handleBackdropClick} aria-hidden={false}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        style={panelStyle}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            fontSize: 16,
            fontWeight: 600,
            color: tokens.text.primary,
            marginBottom: 20,
          }}
        >
          <span id={titleId}>Add Stream</span>
          <button
            type="button"
            aria-label="Close dialog"
            onClick={onClose}
            style={{
              border: "none",
              background: "none",
              fontSize: 18,
              cursor: "pointer",
              color: tokens.text.muted,
              padding: 4,
              lineHeight: 1,
              fontFamily: "inherit",
            }}
          >
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: 14 }}>
            <label style={labelStyle}>Input Type</label>
            <div
              role="tablist"
              aria-label="Stream input type"
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(3, 1fr)",
                gap: 8,
              }}
            >
              {([
                { kind: "url", label: "URL", description: "RTSP / HTTP" },
                { kind: "web", label: "Web Link", description: "Browser camera" },
                { kind: "qr", label: "QR Code", description: "Phone camera" },
              ] as const).map((option) => {
                const selected = sourceKind === option.kind;
                return (
                  <button
                    key={option.kind}
                    type="button"
                    role="tab"
                    aria-selected={selected}
              onClick={() => {
                setSourceKind(option.kind);
                setPhoneSetup(null);
                setError(null);
                setSubmitMessage(null);
                if (option.kind === "url") {
                        requestAnimationFrame(() => urlRef.current?.focus());
                      } else {
                        requestAnimationFrame(() => nameRef.current?.focus());
                      }
                    }}
                    style={{
                      minHeight: 56,
                      border: "none",
                      borderRadius: tokens.radius.md,
                      background: selected ? tokens.accent.soft : tokens.bg.elevated,
                      color: selected ? tokens.accent.base : tokens.text.secondary,
                      boxShadow: selected ? "inset 0 0 0 1px rgba(47,109,246,0.18)" : tokens.shadow.border,
                      cursor: "pointer",
                      fontFamily: tokens.font.sans,
                      textAlign: "left",
                      padding: "10px 12px",
                    }}
                  >
                    <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 3 }}>{option.label}</div>
                    <div style={{ fontSize: 11, color: selected ? tokens.accent.base : tokens.text.muted }}>
                      {option.description}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {sourceKind === "url" && (
            <div style={{ marginBottom: 14 }}>
              <label style={labelStyle}>Stream URL</label>
              <input
                ref={urlRef}
                type="text"
                value={streamUrl}
                onChange={(e) => setStreamUrl(e.target.value)}
                placeholder="rtsp://... or http://..."
                style={inputStyle}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          )}

          {/* Stream name / camera ID */}
          <div style={{ marginBottom: 18 }}>
            <label style={labelStyle}>Camera ID</label>
            <input
              ref={nameRef}
              type="text"
              value={streamName}
              onChange={(e) => {
                setStreamName(e.target.value);
                setPhoneSetup(null);
              }}
              placeholder="my-camera"
              style={inputStyle}
              autoComplete="off"
              spellCheck={false}
            />
          </div>

          {sourceKind !== "url" && phoneSetup && (
            <div
              style={{
                marginBottom: 16,
                padding: 12,
                borderRadius: tokens.radius.md,
                background: "rgba(47,109,246,0.06)",
                boxShadow: "inset 0 0 0 1px rgba(47,109,246,0.12)",
              }}
            >
              <div style={{ fontSize: 12, fontWeight: 700, color: tokens.text.primary, marginBottom: 8 }}>
                {sourceKind === "qr" ? "Scan QR code" : "Open web camera link"}
              </div>
              {sourceKind === "qr" && phoneSetup.qr_data_url && (
                <img
                  src={phoneSetup.qr_data_url}
                  alt="Phone camera setup QR code"
                  style={{
                    width: 160,
                    height: 160,
                    display: "block",
                    borderRadius: tokens.radius.sm,
                    background: "#fff",
                    marginBottom: 10,
                  }}
                />
              )}
              {phoneSetup.node_url && (
                <div style={{ display: "grid", gap: 8 }}>
                  <a
                    href={phoneSetup.node_url}
                    target="_blank"
                    rel="noreferrer"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      minHeight: 34,
                      padding: "8px 12px",
                      borderRadius: tokens.radius.md,
                      background: tokens.accent.base,
                      color: "#fff",
                      fontSize: 12,
                      fontWeight: 700,
                      textDecoration: "none",
                    }}
                  >
                    Open camera link
                  </a>
                  <a
                    href={phoneSetup.node_url}
                    target="_blank"
                    rel="noreferrer"
                    style={{
                      fontSize: 11,
                      color: tokens.accent.base,
                      wordBreak: "break-all",
                      textDecoration: "none",
                    }}
                  >
                    {phoneSetup.node_url}
                  </a>
                </div>
              )}
              {phoneSetup.message && (
                <div style={{ marginTop: 8, fontSize: 11, color: tokens.text.secondary, lineHeight: 1.45 }}>
                  {phoneSetup.message}
                </div>
              )}
              {!phoneSetup.node_url && (
                <div style={{ marginTop: 8, fontSize: 11, color: tokens.semantic.red, lineHeight: 1.45 }}>
                  No web camera link was returned. Try a different Camera ID or remove the existing source and add it again.
                </div>
              )}
              <div style={{ marginTop: 8, fontSize: 11, color: tokens.text.muted, lineHeight: 1.5 }}>
                Keep this page open while streaming. After the camera page is connected, start analysis from this dialog.
              </div>
            </div>
          )}

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>
            <div>
              <label style={labelStyle}>Mode</label>
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value === "event" ? "event" : "stream")}
                style={inputStyle}
              >
                <option value="stream">Stream · continuous live analysis</option>
                <option value="event">Event · motion-triggered recording</option>
              </select>
              <div style={{ marginTop: 6, fontSize: 11, color: tokens.text.muted, lineHeight: 1.4 }}>
                {mode === "stream"
                  ? "Recommended for live demo playback and continuous moments."
                  : "Records motion windows and may produce longer clips."}
              </div>
            </div>
            <div>
              <label style={labelStyle}>FPS</label>
              <input
                type="number"
                min="0.1"
                max="30"
                step="0.1"
                value={fps}
                onChange={(e) => setFps(e.target.value)}
                style={inputStyle}
              />
            </div>
          </div>

          <div style={{ marginBottom: 16 }}>
            <label style={labelStyle}>Duration seconds</label>
            <input
              type="number"
              min="1"
              step="1"
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
              placeholder="Empty = keep running"
              style={inputStyle}
            />
          </div>

          <div style={{ marginBottom: 16 }}>
            <label style={labelStyle}>Background Context</label>
            <textarea
              value={backgroundInfo}
              onChange={(e) => setBackgroundInfo(e.target.value)}
              placeholder="Optional: tell the system what this camera is watching, where it is, who may appear, and what you want it to pay attention to."
              rows={3}
              style={{
                ...inputStyle,
                minHeight: 74,
                resize: "vertical",
                lineHeight: 1.45,
              }}
            />
          </div>

          {/* Error */}
              {error && (
            <div
              role="alert"
              style={{
                fontSize: 12,
                color: tokens.semantic.red,
                marginBottom: 14,
                lineHeight: 1.4,
              }}
            >
              {error}
            </div>
          )}
          {submitMessage && !error && (
            <div
              role="status"
              style={{
                fontSize: 12,
                color: tokens.text.secondary,
                marginBottom: 14,
                lineHeight: 1.4,
              }}
            >
              {submitMessage}
            </div>
          )}

          {/* Actions */}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button
              type="button"
              onClick={onClose}
              style={{
                padding: "7px 16px",
                borderRadius: tokens.radius.md,
                fontSize: 13,
                fontWeight: 500,
                fontFamily: "inherit",
                cursor: "pointer",
                border: "none",
                background: tokens.bg.inset,
                color: tokens.text.secondary,
              }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              style={{
                padding: "7px 20px",
                borderRadius: tokens.radius.md,
                fontSize: 13,
                fontWeight: 500,
                fontFamily: "inherit",
                cursor: canSubmit ? "pointer" : "not-allowed",
                border: "none",
                background: canSubmit ? tokens.accent.base : tokens.text.faint,
                color: "#fff",
                opacity: canSubmit ? 1 : 0.6,
                transition: "background 0.15s, opacity 0.15s",
              }}
            >
              {submitting
                ? sourceKind !== "url" && !phoneSetup
                  ? "Preparing..."
                  : sourceKind !== "url"
                    ? "Connecting..."
                    : "Starting..."
                : sourceKind !== "url" && !phoneSetup
                  ? sourceKind === "qr" ? "Generate QR" : "Generate Link"
                  : "Start Analysis"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
