import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { MonitorEvent } from "../../types";
import type { ActiveAnalysis } from "../../hooks/useMonitorSocket";
import type { DashboardSession } from "../../session";
import { dashboardAuthHeaders, withDashboardQuery } from "../../session";
import { useMediaSources, type MediaSourceSession } from "../../hooks/useMediaSources";
import { tokens } from "../../theme/tokens";
import { CameraTabs } from "./CameraTabs";
import { LiveVideo } from "./LiveVideo";
import { StreamUrlDialog } from "./StreamUrlDialog";
import { UploadRow } from "./UploadRow";
import { VideoSelector } from "./VideoSelector";
import { ChatPanel, type ChatMessage, type ChatVoiceControls } from "../chat/ChatPanel";

interface SidebarProps {
  events: MonitorEvent[];
  analyses: ActiveAnalysis[];
  selectedCamera: string | null;
  onSelectCamera: (id: string | null) => void;
  session: DashboardSession;
  chatMessages: ChatMessage[];
  chatContextLabel: string;
  chatSuggestions: string[];
  onChatClear: () => void;
  onChatSend: (text: string) => void;
  chatVoice?: ChatVoiceControls;
  pendingRemovedSourceIds: ReadonlySet<string>;
  onSourceRemovePendingChange: (sourceId: string, pending: boolean) => void;
}

type PendingSourceOverride = Partial<Pick<MediaSourceSession, "status" | "canStart" | "canStop" | "meta">> & {
  operation: "start" | "stop";
  requestId: number;
};

function toLiveVideoStatus(status: string | undefined): "active" | "waiting" | "stopped" | "reconnecting" | "unavailable" {
  if (status === "waiting" || status === "stopped" || status === "reconnecting" || status === "unavailable") return status;
  return "active";
}

/**
 * Left sidebar composition: live video + VLM summary, camera switcher,
 * upload affordances, and a 3D scene placeholder.
 *
 * Camera list and per-camera derived data (mode, latest VLM summary) are
 * computed locally from the event log so the parent stays thin. The most
 * recent matching event wins because `useMonitorSocket` returns events in
 * newest-first order. When no camera is selected and cameras become
 * available, the first camera is auto-selected to avoid an empty video pane.
 */
export function Sidebar({
  events,
  analyses,
  selectedCamera,
  onSelectCamera,
  session,
  chatMessages,
  chatContextLabel,
  chatSuggestions,
  onChatClear,
  onChatSend,
  chatVoice,
  pendingRemovedSourceIds,
  onSourceRemovePendingChange,
}: SidebarProps) {
  const [streamDialogOpen, setStreamDialogOpen] = useState(false);
  const [videoSelectorOpen, setVideoSelectorOpen] = useState(false);
  const [semanticContextOpen, setSemanticContextOpen] = useState(false);
  const [semanticContextLoading, setSemanticContextLoading] = useState(false);
  const [semanticContextText, setSemanticContextText] = useState("");
  const [semanticContextError, setSemanticContextError] = useState<string | null>(null);
  const [semanticContextSourceId, setSemanticContextSourceId] = useState<string | null>(null);
  const [uploadAutoplay, setUploadAutoplay] = useState<{ cameraId: string; token: number } | null>(null);
  const [pendingSourceOverrides, setPendingSourceOverrides] = useState<Map<string, PendingSourceOverride>>(() => new Map());
  const sourceOperationRequestRef = useRef(0);
  const selectedCameraRef = useRef(selectedCamera);
  const hostname = typeof window !== "undefined" ? window.location.hostname : "localhost";
  const rawMediaSources = useMediaSources(events, analyses);
  const mediaSources = useMemo(
    () => rawMediaSources
      .filter((source) => !pendingRemovedSourceIds.has(source.id))
      .map((source) => {
        const override = pendingSourceOverrides.get(source.id);
        if (!override) return source;
        const { operation: _operation, ...sourceOverride } = override;
        return { ...source, ...sourceOverride };
      }),
    [pendingRemovedSourceIds, pendingSourceOverrides, rawMediaSources],
  );

  useEffect(() => {
    selectedCameraRef.current = selectedCamera;
  }, [selectedCamera]);

  useEffect(() => {
    if (pendingSourceOverrides.size === 0) return;
    let changed = false;
    const next = new Map(pendingSourceOverrides);
    for (const source of rawMediaSources) {
      const override = pendingSourceOverrides.get(source.id);
      if (!override) continue;
      const hasSettled = override.operation === "stop"
        ? source.status === "stopped" || source.status === "unavailable"
        : source.status !== "stopped";
      if (hasSettled) {
        next.delete(source.id);
        changed = true;
      }
    }
    if (changed) setPendingSourceOverrides(next);
  }, [pendingSourceOverrides, rawMediaSources]);

  const stopSource = useCallback(async (id: string) => {
    const source = mediaSources.find((item) => item.id === id);
    if (!source) return;
    const requestId = ++sourceOperationRequestRef.current;
    setPendingSourceOverrides((prev) => {
      const next = new Map(prev);
      next.set(id, { operation: "stop", requestId, status: "stopped", canStart: false, canStop: false, meta: "Stopping..." });
      return next;
    });
    try {
      const response = await fetch("/api/sources/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...dashboardAuthHeaders(session) },
        body: JSON.stringify({
          source_id: id,
          session_id: session.sessionId,
          user_id: session.userId,
        }),
      });
      const data = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(data.error ?? `stop_watch failed (${response.status})`);
    } catch (err) {
      setPendingSourceOverrides((prev) => {
        const current = prev.get(id);
        if (current?.operation !== "stop" || current.requestId !== requestId) return prev;
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
      window.alert(err instanceof Error ? err.message : "Failed to stop watch");
    }
  }, [mediaSources, session]);

  const startSource = useCallback(async (id: string) => {
    const source = mediaSources.find((item) => item.id === id);
    if (!source || source.kind !== "live") return;
    const requestId = ++sourceOperationRequestRef.current;
    setPendingSourceOverrides((prev) => {
      const next = new Map(prev);
      next.set(id, { operation: "start", requestId, status: "waiting", canStart: false, canStop: false, meta: "Starting..." });
      return next;
    });
    try {
      const response = await fetch("/api/streams/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...dashboardAuthHeaders(session) },
        body: JSON.stringify({
          name: id,
          mode: source.mode === "stream" ? "stream" : "event",
          fps: 1,
          session_id: session.sessionId,
          user_id: session.userId,
        }),
      });
      const data = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(data.error ?? `start_watch failed (${response.status})`);
    } catch (err) {
      setPendingSourceOverrides((prev) => {
        const current = prev.get(id);
        if (current?.operation !== "start" || current.requestId !== requestId) return prev;
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
      window.alert(err instanceof Error ? err.message : "Failed to start watch");
    }
  }, [mediaSources, session]);

  const removeSource = useCallback(async (id: string) => {
    const source = mediaSources.find((item) => item.id === id);
    if (!source?.canRemove) return;
    const confirmed = window.confirm(
      source.kind === "upload"
        ? `Delete source "${source.label}"?\n\nThis will stop analysis and remove its Moments, Entities, Scene Understanding, memories, and generated media from this Dashboard session. The uploaded video file will remain available for re-analysis.`
        : `Delete source "${source.label}"?\n\nThis will stop the watch and permanently remove its Moments, Entities, Scene Understanding, memories, and generated media from this Dashboard session.`,
    );
    if (!confirmed) return;

    const previousSelectedCamera = selectedCamera;
    const nextSelectedCamera = mediaSources.find((item) => item.id !== id)?.id ?? null;
    onSourceRemovePendingChange(id, true);
    if (selectedCamera === id) {
      onSelectCamera(nextSelectedCamera);
    }

    try {
      const response = await fetch("/api/sources/remove", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...dashboardAuthHeaders(session) },
        body: JSON.stringify({
          source_id: id,
          session_id: session.sessionId,
          user_id: session.userId,
          ...(source.videoId ? { video_id: source.videoId } : {}),
        }),
      });
      const data = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) {
        throw new Error(data.error ?? `remove_source failed (${response.status})`);
      }
    } catch (err) {
      onSourceRemovePendingChange(id, false);
      if (previousSelectedCamera === id && selectedCameraRef.current === nextSelectedCamera) {
        onSelectCamera(id);
      }
      window.alert(err instanceof Error ? err.message : "Failed to remove source");
    }
  }, [mediaSources, onSelectCamera, onSourceRemovePendingChange, selectedCamera, session]);

  // Keep the selected camera valid as temporary video sources come and go.
  useEffect(() => {
    if (mediaSources.length === 0) {
      if (selectedCamera !== null) onSelectCamera(null);
      return;
    }
    if (selectedCamera === null || !mediaSources.some((source) => source.id === selectedCamera)) {
      onSelectCamera(mediaSources[0]?.id ?? null);
    }
  }, [mediaSources, selectedCamera, onSelectCamera]);

  const selectedSource = useMemo(
    () => mediaSources.find((source) => source.id === selectedCamera),
    [mediaSources, selectedCamera],
  );

  const openSemanticContext = useCallback(async (cameraId?: string) => {
    const targetCamera = cameraId ?? selectedCamera;
    if (!targetCamera) return;
    setSemanticContextSourceId(targetCamera);
    setSemanticContextOpen(true);
    setSemanticContextLoading(true);
    setSemanticContextError(null);
    setSemanticContextText("");
    try {
      const response = await fetch(
        withDashboardQuery(`/api/semantic-context?camera_id=${encodeURIComponent(targetCamera)}`, session),
        { headers: dashboardAuthHeaders(session) },
      );
      const data = await response.json().catch(() => ({})) as { content?: string; error?: string };
      if (!response.ok) throw new Error(data.error ?? `Scene Understanding failed (${response.status})`);
      setSemanticContextText(data.content ?? "");
    } catch (err) {
      setSemanticContextError(err instanceof Error ? err.message : "Failed to load Scene Understanding");
    } finally {
      setSemanticContextLoading(false);
    }
  }, [selectedCamera, session]);

  const handleUploadAnalysisStarted = useCallback((cameraId: string) => {
    onSelectCamera(cameraId);
    setUploadAutoplay({ cameraId, token: Date.now() });
  }, [onSelectCamera]);

  const handleStreamStarted = useCallback((cameraId: string) => {
    if (!cameraId) return;
    onSourceRemovePendingChange(cameraId, false);
    onSelectCamera(cameraId);
  }, [onSelectCamera, onSourceRemovePendingChange]);

  const liveAutoplayToken = selectedSource?.kind === "upload" && uploadAutoplay?.cameraId === selectedCamera
    ? uploadAutoplay.token
    : undefined;

  return (
    <div
      style={{
        padding: 0,
        height: "100%",
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{ flexShrink: 0 }}>
        <LiveVideo
          cameraId={selectedCamera}
          session={session}
          summary={selectedSource?.summary}
          mode={selectedSource?.mode}
          previewUrl={selectedSource?.previewUrl}
          autoplayToken={liveAutoplayToken}
          sourceStatus={selectedSource?.kind === "live" ? toLiveVideoStatus(selectedSource.status) : "active"}
          sourceInput={selectedSource?.sourceInput}
          sourceProtocol={selectedSource?.sourceProtocol}
        />
      </div>
      {mediaSources.length === 0 ? (
        <div style={{ flexShrink: 0 }}>
          <UploadRow
            onUploadVideo={() => setVideoSelectorOpen(true)}
            onAddStream={() => setStreamDialogOpen(true)}
          />
        </div>
      ) : null}
      <div style={{ flexShrink: 0 }}>
        <CameraTabs
          cameras={mediaSources}
          active={selectedCamera}
          onSelect={onSelectCamera}
          onStart={startSource}
          onStop={stopSource}
          onRemove={removeSource}
          onInfo={(cameraId) => void openSemanticContext(cameraId)}
          onUploadVideo={() => setVideoSelectorOpen(true)}
          onAddStream={() => setStreamDialogOpen(true)}
        />
      </div>
      <ChatPanel
        variant="inline"
        messages={chatMessages}
        contextLabel={chatContextLabel}
        suggestions={chatSuggestions}
        onClear={onChatClear}
        onSend={onChatSend}
        voice={chatVoice}
      />
      <VideoSelector
        open={videoSelectorOpen}
        onClose={() => setVideoSelectorOpen(false)}
        onAnalysisStarted={handleUploadAnalysisStarted}
        session={session}
      />
      <StreamUrlDialog
        open={streamDialogOpen}
        onClose={() => setStreamDialogOpen(false)}
        hostname={hostname}
        session={session}
        onStreamStarted={handleStreamStarted}
      />
      {semanticContextOpen && (
        <SemanticContextModal
          sourceLabel={mediaSources.find((source) => source.id === semanticContextSourceId)?.label ?? semanticContextSourceId ?? "Source"}
          loading={semanticContextLoading}
          error={semanticContextError}
          content={semanticContextText}
          onClose={() => setSemanticContextOpen(false)}
        />
      )}
    </div>
  );
}

function SemanticContextModal({
  sourceLabel,
  loading,
  error,
  content,
  onClose,
}: {
  sourceLabel: string;
  loading: boolean;
  error: string | null;
  content: string;
  onClose: () => void;
}) {
  return (
    <div
      style={semanticBackdropStyle}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div role="dialog" aria-modal="true" aria-label="Scene Understanding" style={semanticPanelStyle}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 12 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 750, color: tokens.text.primary }}>Scene Understanding</div>
            <div style={{ marginTop: 2, fontSize: 12, color: tokens.text.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              Source-level scene and background context for {sourceLabel}.
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" style={semanticCloseStyle}>X</button>
        </div>
        <div style={semanticContentStyle}>
          {loading ? (
            <span style={{ color: tokens.text.muted }}>Loading scene understanding...</span>
          ) : error ? (
            <span style={{ color: tokens.semantic.red }}>{error}</span>
          ) : content.trim() ? (
            content
          ) : (
            <span style={{ color: tokens.text.faint }}>No scene understanding has been recorded for this source yet.</span>
          )}
        </div>
      </div>
    </div>
  );
}

const semanticBackdropStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 230,
  background: "rgba(15, 23, 42, 0.42)",
  backdropFilter: "blur(5px)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 20,
};

const semanticPanelStyle: CSSProperties = {
  width: 560,
  maxWidth: "100%",
  maxHeight: "82vh",
  borderRadius: 22,
  background: tokens.bg.surface,
  boxShadow: tokens.shadow.elevated,
  padding: 18,
  fontFamily: tokens.font.sans,
};

const semanticCloseStyle: CSSProperties = {
  border: "none",
  background: "transparent",
  color: tokens.text.muted,
  cursor: "pointer",
  fontSize: 16,
  fontFamily: tokens.font.sans,
};

const semanticContentStyle: CSSProperties = {
  minHeight: 180,
  maxHeight: "62vh",
  overflow: "auto",
  borderRadius: tokens.radius.md,
  padding: "12px 14px",
  background: tokens.bg.inset,
  color: tokens.text.secondary,
  fontFamily: "'SFMono-Regular', Consolas, monospace",
  fontSize: 12,
  lineHeight: 1.6,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  boxShadow: "inset 0 0 0 1px rgba(31,45,71,0.06)",
};
