import { useCallback, useEffect, useMemo, useState } from "react";
import { useMonitorSocket } from "./hooks/useMonitorSocket";
import { useSegments } from "./hooks/useSegments";
import { deriveMediaSources } from "./hooks/useMediaSources";
import { useEntityAliases } from "./hooks/useEntityAliases";
import { useSemanticMemories } from "./hooks/useSemanticMemories";
import { useEntitySightings } from "./hooks/useEntitySightings";
import { useProceduralRules } from "./hooks/useProceduralRules";
import { useMemoryPanelData } from "./hooks/useMemoryPanelData";
import { useLiveAgent } from "./hooks/useLiveAgent";
import { useSelectionState } from "./state/useSelectionState";
import { TopBar } from "./components/layout/TopBar";
import { MainLayout } from "./components/layout/MainLayout";
import { BottomBar } from "./components/layout/BottomBar";
import { Sidebar } from "./components/sidebar/Sidebar";
import { SegmentList } from "./components/segments/SegmentList";
import { EntityPanel } from "./components/entities/EntityPanel";
import { MemoryPanel } from "./components/memory/MemoryPanel";
import { RulesButton } from "./components/rules/RulesButton";
import type { ChatMessage } from "./components/chat/ChatPanel";
import type { Segment } from "./hooks/useSegments";
import { SettingsOverlay } from "./components/settings/SettingsOverlay";
import { Icon } from "./theme/icons";
import { IconSprite } from "./theme/icons";
import { tokens } from "./theme/tokens";
import type { MonitorEvent } from "./types";
import type { EntityActivity } from "./components/entities/EntityDetail";
import { getDashboardSession } from "./session";
import { dashboardAuthHeaders } from "./session";
import { resolveDashboardChatReply } from "./chat-response";

const SELECTED_SOURCE_STORAGE_KEY = "reflectworld.dashboard.selected_source.v1";
const ALL_SOURCES_CHAT_KEY = "__all_sources__";

function loadSelectedSource(): string | null {
  try {
    const value = window.sessionStorage.getItem(SELECTED_SOURCE_STORAGE_KEY)?.trim();
    return value || null;
  } catch {
    return null;
  }
}

function eventCameraId(event: MonitorEvent): string | null {
  if (typeof event.camera_id === "string" && event.camera_id) return event.camera_id;
  const sourceId = event.data.source_id;
  if (typeof sourceId === "string" && sourceId) return sourceId;
  const id = event.data.id;
  if (typeof id === "string" && id) return id;
  return null;
}

function readNumber(data: Record<string, unknown>, key: string): number | undefined {
  const value = data[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function looksLikeVideoSource(value: unknown): boolean {
  return typeof value === "string" && /\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(value.trim());
}

function eventUsesMediaTime(event: MonitorEvent, mediaSourceByCamera?: Map<string, boolean>): boolean {
  if (event.type === "dashboard:segment_state") {
    return (
      event.data.display_time_mode === "media"
      || event.data.is_media_source === true
      || looksLikeVideoSource(event.data.source_label)
      || looksLikeVideoSource(event.data.video_id)
    );
  }
  const cameraId = event.camera_id ?? "";
  return (
    event.data.is_media_source === true ||
    event.data.protocol === "file" ||
    typeof event.data.video_id === "string" ||
    looksLikeVideoSource(event.data.source_label) ||
    cameraId.startsWith("video-") ||
    mediaSourceByCamera?.get(cameraId) === true
  );
}

function eventDisplayStartTime(event: MonitorEvent): number {
  if (event.type === "dashboard:segment_state") {
    return readNumber(event.data, "display_start_time")
      ?? readNumber(event.data, "segment_start")
      ?? readNumber(event.data, "start_time")
      ?? event.timestamp;
  }
  return (
    readNumber(event.data, "display_start_time") ??
    readNumber(event.data, "segment_start") ??
    readNumber(event.data, "start_time") ??
    event.timestamp
  );
}

function formatMediaTime(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatSegmentLabelTime(segment: Segment): string {
  const start = segment.display_start_time ?? segment.start_time;
  const timeMode = segment.display_time_mode ?? (segment.is_media_source ? "media" : "wall_clock");
  if (timeMode === "media") return formatMediaTime(start);
  return new Date(start).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function findVoiceMessageIndex(messages: ChatMessage[], role: ChatMessage["role"], turnId: number): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.mode === "voice" && message.role === role && message.voiceTurnId === turnId) return i;
  }
  return -1;
}

type DashboardChatStreamEvent =
  | { type: "status"; message: string }
  | { type: "delta"; text: string }
  | { type: "done"; answer?: string }
  | { type: "error"; error: string };

function parseSseEvent(block: string): DashboardChatStreamEvent | null {
  const dataLines = block
    .split(/\r?\n/)
    .filter(line => line.startsWith("data:"))
    .map(line => line.slice(5).trimStart());
  if (dataLines.length === 0) return null;
  try {
    return JSON.parse(dataLines.join("\n")) as DashboardChatStreamEvent;
  } catch {
    return null;
  }
}

function SessionGate({ title, message, detail }: { title: string; message: string; detail?: string }) {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "linear-gradient(135deg, #f8fafc, #eef2f7)",
        fontFamily: tokens.font.sans,
        color: tokens.text.primary,
        padding: 24,
      }}
    >
      <div
        style={{
          maxWidth: 480,
          borderRadius: 24,
          background: tokens.bg.surface,
          boxShadow: tokens.shadow.elevated,
          padding: 28,
          textAlign: "center",
        }}
      >
        <div style={{ fontSize: 18, fontWeight: 750, marginBottom: 10 }}>{title}</div>
        <div style={{ fontSize: 13, color: tokens.text.secondary, lineHeight: 1.6 }}>{message}</div>
        {detail && <div style={{ marginTop: 12, fontSize: 12, color: tokens.text.muted }}>{detail}</div>}
      </div>
    </div>
  );
}

/**
 * Derive per-entity aggregates (sightings, cameras, recent activity) from
 * the event stream. Walks canonical segment state first, with legacy
 * `perception:vlm_result` events as fallback.
 */
function useEntityAggregates(
  events: MonitorEvent[],
): {
  sightingsMap: Map<string, number>;
  camerasMap: Map<string, string[]>;
  activityMap: Map<string, EntityActivity[]>;
} {
  return useMemo(() => {
    const sightingsMap = new Map<string, number>();
    const camerasMap = new Map<string, Set<string>>();
    const activityMap = new Map<string, EntityActivity[]>();
    const sourceLabelByCamera = new Map<string, string>();
    const mediaSourceByCamera = new Map<string, boolean>();

    for (const e of events) {
      const cameraId = e.camera_id ?? (typeof e.data.source_id === "string" ? e.data.source_id : "");
      if (!cameraId) continue;
      if (!sourceLabelByCamera.has(cameraId)) {
        const rawLabel = typeof e.data.source_name === "string"
          ? e.data.source_name
          : typeof e.data.video_id === "string"
            ? e.data.video_id
            : cameraId;
        const parts = rawLabel.trim().split(/[\\/]/).filter(Boolean);
        sourceLabelByCamera.set(cameraId, parts[parts.length - 1] ?? rawLabel);
      }
      if (!mediaSourceByCamera.has(cameraId)) {
        mediaSourceByCamera.set(
          cameraId,
          e.data.protocol === "file" || typeof e.data.video_id === "string" || cameraId.startsWith("video-"),
        );
      }
    }

    const canonicalSegmentIds = new Set<string>();
    for (const e of events) {
      if (e.type !== "dashboard:segment_state") continue;
      const segmentId = typeof e.data.segment_id === "string" ? e.data.segment_id : "";
      if (segmentId) canonicalSegmentIds.add(segmentId);
    }

    for (const e of events) {
      if (e.type !== "perception:vlm_result" && e.type !== "dashboard:segment_state") continue;
      const segmentId = typeof e.data.segment_id === "string" ? e.data.segment_id : "";
      if (e.type === "perception:vlm_result" && segmentId && canonicalSegmentIds.has(segmentId)) continue;
      const camera_id = e.camera_id ?? "unknown";
      const ts = eventDisplayStartTime(e);
      const isMediaTime = eventUsesMediaTime(e, mediaSourceByCamera);
      const mainTargets = e.type === "dashboard:segment_state" ? e.data.targets : e.data.main_targets;
      if (!Array.isArray(mainTargets)) continue;
      for (const raw of mainTargets) {
        if (!raw || typeof raw !== "object") continue;
        const t = raw as Record<string, unknown>;
        const entityId = typeof t.entity_id === "string" && t.entity_id ? t.entity_id : "";
        if (!entityId) continue;
        if (typeof t.crop_path !== "string" || !t.crop_path) continue;
        sightingsMap.set(entityId, (sightingsMap.get(entityId) ?? 0) + 1);
        if (!camerasMap.has(entityId)) camerasMap.set(entityId, new Set());
        camerasMap.get(entityId)!.add(camera_id);
        const behavior = typeof t.behavior === "string" ? t.behavior : "";
        if (behavior) {
          if (!activityMap.has(entityId)) activityMap.set(entityId, []);
          activityMap.get(entityId)!.push({
            time: ts,
            camera_id,
            source_label: sourceLabelByCamera.get(camera_id) ?? camera_id,
            is_media_source: isMediaTime,
            behavior,
          });
        }
      }
    }

    // Convert sets to arrays and cap activity lists at 20 entries.
    const camerasOut = new Map<string, string[]>();
    for (const [id, set] of camerasMap) camerasOut.set(id, Array.from(set));
    for (const list of activityMap.values()) {
      list.sort((a, b) => b.time - a.time);
      if (list.length > 20) list.length = 20;
    }

    return { sightingsMap, camerasMap: camerasOut, activityMap };
  }, [events]);
}

export function App() {
  const session = useMemo(() => getDashboardSession(), []);
  const [admission, setAdmission] = useState<
    | { status: "checking" }
    | { status: "accepted"; multiUser: boolean }
    | { status: "full"; message: string; maxActiveSessions?: number }
    | { status: "error"; message: string }
  >({ status: "checking" });
  const { events, connected, analyses } = useMonitorSocket(session, admission.status === "accepted");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [entityPanelOpen, setEntityPanelOpen] = useState(false);
  const [memoryPanelOpen, setMemoryPanelOpen] = useState(false);
  const [entityPanelCollapsedBySource, setEntityPanelCollapsedBySource] = useState<Record<string, boolean>>({});
  const [selectedCamera, setSelectedCamera] = useState<string | null>(() => loadSelectedSource());
  const [chatMessagesBySource, setChatMessagesBySource] = useState<Record<string, ChatMessage[]>>({});
  const [clearingDashboard, setClearingDashboard] = useState(false);
  const [pendingRemovedSourceIds, setPendingRemovedSourceIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    let cancelled = false;
    async function startSession() {
      try {
        const resp = await fetch("/api/dashboard/session/start", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...dashboardAuthHeaders(session) },
          body: JSON.stringify({
            session_id: session.sessionId,
            user_id: session.userId,
            is_admin: session.isAdmin,
            ...(session.adminToken ? { admin_token: session.adminToken } : {}),
          }),
        });
        const data = await resp.json().catch(() => ({})) as {
          ok?: boolean;
          multi_user?: boolean;
          message?: string;
          max_active_sessions?: number;
          error?: string;
        };
        if (cancelled) return;
        if (resp.status === 429) {
          setAdmission({
            status: "full",
            message: data.message ?? "Demo capacity is full. Please try again later.",
            maxActiveSessions: data.max_active_sessions,
          });
          return;
        }
        if (!resp.ok || data.ok !== true) {
          setAdmission({ status: "error", message: data.error ?? `Session start failed (${resp.status})` });
          return;
        }
        setAdmission({ status: "accepted", multiUser: data.multi_user === true });
      } catch (err) {
        if (!cancelled) setAdmission({ status: "error", message: err instanceof Error ? err.message : "Session start failed" });
      }
    }
    void startSession();
    return () => {
      cancelled = true;
    };
  }, [session]);

  useEffect(() => {
    if (admission.status !== "accepted" || !admission.multiUser) return;
    const heartbeat = () => {
      void fetch("/api/dashboard/session/heartbeat", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...dashboardAuthHeaders(session) },
        body: JSON.stringify({ session_id: session.sessionId, user_id: session.userId }),
      }).catch(() => undefined);
    };
    heartbeat();
    const id = window.setInterval(heartbeat, 15_000);
    const end = () => {
      const payload = JSON.stringify({ session_id: session.sessionId, user_id: session.userId });
      if (navigator.sendBeacon) {
        navigator.sendBeacon("/api/dashboard/session/end", new Blob([payload], { type: "application/json" }));
      } else {
        void fetch("/api/dashboard/session/end", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...dashboardAuthHeaders(session) },
          body: payload,
          keepalive: true,
        }).catch(() => undefined);
      }
    };
    window.addEventListener("pagehide", end);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("pagehide", end);
    };
  }, [admission, session]);

  const setSourceRemovePending = useCallback((sourceId: string, pending: boolean) => {
    setPendingRemovedSourceIds((prev) => {
      if (pending && prev.has(sourceId)) return prev;
      if (!pending && !prev.has(sourceId)) return prev;
      const next = new Set(prev);
      if (pending) next.add(sourceId);
      else next.delete(sourceId);
      return next;
    });
  }, []);

  useEffect(() => {
    if (pendingRemovedSourceIds.size === 0) return;
    const confirmedRemoved = new Set<string>();
    for (const event of events) {
      if (event.type !== "dashboard:source_state" || event.data.op !== "remove") continue;
      const sourceId = eventCameraId(event);
      if (sourceId) confirmedRemoved.add(sourceId);
    }
    if (confirmedRemoved.size === 0) return;
    setPendingRemovedSourceIds((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const sourceId of confirmedRemoved) {
        if (next.delete(sourceId)) changed = true;
      }
      return changed ? next : prev;
    });
    setChatMessagesBySource((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const sourceId of confirmedRemoved) {
        if (sourceId in next) {
          delete next[sourceId];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [events, pendingRemovedSourceIds]);

  useEffect(() => {
    if (selectedCamera && pendingRemovedSourceIds.has(selectedCamera)) {
      setSelectedCamera(null);
    }
  }, [pendingRemovedSourceIds, selectedCamera]);

  const visibleEvents = useMemo(() => {
    if (pendingRemovedSourceIds.size === 0) return events;
    return events.filter((event) => {
      const sourceId = eventCameraId(event);
      return !sourceId || !pendingRemovedSourceIds.has(sourceId);
    });
  }, [events, pendingRemovedSourceIds]);

  const visibleAnalyses = useMemo(
    () => analyses.filter((analysis) => !pendingRemovedSourceIds.has(analysis.camera_id)),
    [analyses, pendingRemovedSourceIds],
  );

  const contentEvents = useMemo(() => {
    if (!selectedCamera) return visibleEvents;
    return visibleEvents.filter((event) => eventCameraId(event) === selectedCamera);
  }, [selectedCamera, visibleEvents]);

  const ruleEvents = useMemo(() => {
    if (!selectedCamera) return visibleEvents;
    return visibleEvents.filter((event) => {
      if (
        event.type === "memory:memory_added" &&
        event.data.memory_type === "procedural"
      ) {
        return true;
      }
      return eventCameraId(event) === selectedCamera;
    });
  }, [selectedCamera, visibleEvents]);

  const segments = useSegments(contentEvents);
  const mediaSourceLabels = useMemo(() => {
    const labels = new Map<string, string>();
    for (const source of deriveMediaSources(visibleEvents, visibleAnalyses)) {
      labels.set(source.id, source.label);
    }
    return labels;
  }, [visibleAnalyses, visibleEvents]);
  const aliases = useEntityAliases(contentEvents);
  const semanticMap = useSemanticMemories(contentEvents);
  const memoryPanelData = useMemoryPanelData(contentEvents);
  const sightingsGalleryMap = useEntitySightings(contentEvents);
  const { rules, segmentRuleMap, segmentRuleLabelMap, markDeleted } = useProceduralRules(ruleEvents, segments);
  const { sightingsMap, camerasMap, activityMap } = useEntityAggregates(contentEvents);
  const { selection, selectEntity, selectSegment, selectRule, clear } = useSelectionState();
  const visibleEntityCountBySource = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entity of aliases.ordered) {
      const entityId = entity.entity_id;
      const hasEvidence = (sightingsMap.get(entityId) ?? 0) > 0
        || (camerasMap.get(entityId)?.length ?? 0) > 0
        || (activityMap.get(entityId)?.length ?? 0) > 0
        || (sightingsGalleryMap.get(entityId)?.length ?? 0) > 0;
      if (!hasEvidence) continue;
      for (const cameraId of camerasMap.get(entityId) ?? []) {
        counts.set(cameraId, (counts.get(cameraId) ?? 0) + 1);
      }
    }
    return counts;
  }, [activityMap, aliases.ordered, camerasMap, sightingsGalleryMap, sightingsMap]);

  const visibleEntityCount = useMemo(
    () => Array.from(visibleEntityCountBySource.values()).reduce((sum, count) => sum + count, 0),
    [visibleEntityCountBySource],
  );

  const currentSourceEntityCount = selectedCamera
    ? visibleEntityCountBySource.get(selectedCamera) ?? 0
    : visibleEntityCount;
  const entityPanelSourceKey = selectedCamera ?? ALL_SOURCES_CHAT_KEY;

  useEffect(() => {
    const savedCollapsed = entityPanelCollapsedBySource[entityPanelSourceKey];
    if (savedCollapsed !== undefined) {
      setEntityPanelOpen(!savedCollapsed);
      return;
    }
    if (currentSourceEntityCount === 0) {
      setEntityPanelOpen(false);
      return;
    }
    setEntityPanelOpen(true);
    setEntityPanelCollapsedBySource((prev) => (
      prev[entityPanelSourceKey] === false ? prev : { ...prev, [entityPanelSourceKey]: false }
    ));
  }, [currentSourceEntityCount, entityPanelCollapsedBySource, entityPanelSourceKey]);

  useEffect(() => {
    clear();
  }, [selectedCamera, clear]);

  useEffect(() => {
    try {
      if (selectedCamera) {
        window.sessionStorage.setItem(SELECTED_SOURCE_STORAGE_KEY, selectedCamera);
      } else {
        window.sessionStorage.removeItem(SELECTED_SOURCE_STORAGE_KEY);
      }
    } catch {
      // Session persistence is best-effort; source hydration remains authoritative.
    }
  }, [selectedCamera]);

  const analysisStatus = useMemo(() => {
    const latest = [...visibleAnalyses].sort((a, b) => (b.completed_at ?? b.started_at) - (a.completed_at ?? a.started_at))[0];
    if (!latest) return undefined;
    const label = latest.video_id || latest.camera_id;
    if (latest.status === "starting") return `Preparing ${label}...`;
    if (latest.status === "active") {
      return latest.segments_count > 0
        ? `Analyzing ${label}... (${latest.segments_count} segments)`
        : `Analyzing ${label}...`;
    }
    if (latest.status === "completed") return `Analysis complete (${latest.segments_count} segments)`;
    return undefined;
  }, [visibleAnalyses]);

  // Fill each segment's rule labels from procedural memories using the
  // backend-provided matched rule ids on each segment.
  const segmentsWithRules = useMemo(
    () =>
      segments.map(s => ({
        ...s,
        triggered_rules: segmentRuleMap.get(s.segment_id) ?? s.triggered_rules ?? [],
        triggered_rule_labels: segmentRuleLabelMap.get(s.segment_id) ?? s.triggered_rule_labels ?? [],
      })),
    [segments, segmentRuleMap, segmentRuleLabelMap],
  );

  const chatContextLabel = useMemo(() => {
    if (!selectedCamera) return `All sources · ${segmentsWithRules.length} moments`;
    const sourceLabel = segmentsWithRules.find(segment => segment.camera_id === selectedCamera)?.source_label;
    return `${mediaSourceLabels.get(selectedCamera) ?? sourceLabel ?? selectedCamera} · ${segmentsWithRules.length} moments`;
  }, [mediaSourceLabels, selectedCamera, segmentsWithRules]);

  const chatSuggestions = useMemo(() => [
    "What happened recently?",
    "Did anyone appear?",
    "Were there any dangerous events?",
  ], []);

  const chatScopeKey = selectedCamera ?? ALL_SOURCES_CHAT_KEY;
  const chatMessages = chatMessagesBySource[chatScopeKey] ?? [];

  const updateScopedChatMessages = useCallback((scopeKey: string, updater: (messages: ChatMessage[]) => ChatMessage[]) => {
    setChatMessagesBySource(prev => ({
      ...prev,
      [scopeKey]: updater(prev[scopeKey] ?? []),
    }));
  }, []);

  const upsertVoiceMessage = useCallback((scopeKey: string, role: ChatMessage["role"], text: string, turnId: number) => {
    const cleaned = text.trim();
    if (!cleaned) return;
    updateScopedChatMessages(scopeKey, (messages) => {
      const existingIndex = findVoiceMessageIndex(messages, role, turnId);
      if (existingIndex >= 0) {
        const next = messages.slice();
        next[existingIndex] = { ...next[existingIndex], text: cleaned };
        return next;
      }
      return [...messages, { role, text: cleaned, mode: "voice", voiceTurnId: turnId }];
    });
  }, [updateScopedChatMessages]);

  const removeVoiceTurn = useCallback((scopeKey: string, turnId: number) => {
    updateScopedChatMessages(scopeKey, messages => messages.filter(msg => msg.voiceTurnId !== turnId));
  }, [updateScopedChatMessages]);

  const handleLiveUserTranscript = useCallback((text: string, _final: boolean, turnId: number) => {
    upsertVoiceMessage(chatScopeKey, "user", text, turnId);
  }, [chatScopeKey, upsertVoiceMessage]);

  const handleLiveAssistantText = useCallback((text: string, final: boolean, turnId: number) => {
    if (!text && final) return;
    upsertVoiceMessage(chatScopeKey, "assistant", text, turnId);
  }, [chatScopeKey, upsertVoiceMessage]);

  const handleLiveError = useCallback((message: string, turnId: number) => {
    upsertVoiceMessage(chatScopeKey, "assistant", message, turnId);
  }, [chatScopeKey, upsertVoiceMessage]);

  const handleLiveVoicePending = useCallback((turnId: number) => {
    upsertVoiceMessage(chatScopeKey, "user", "Processing voice...", turnId);
  }, [chatScopeKey, upsertVoiceMessage]);

  const handleLiveVoiceDiscard = useCallback((turnId: number) => {
    removeVoiceTurn(chatScopeKey, turnId);
  }, [chatScopeKey, removeVoiceTurn]);

  const liveAgent = useLiveAgent({
    session,
    cameraId: selectedCamera,
    history: chatMessages,
    onUserTranscript: handleLiveUserTranscript,
    onAssistantText: handleLiveAssistantText,
    onError: handleLiveError,
    onVoicePending: handleLiveVoicePending,
    onVoiceDiscard: handleLiveVoiceDiscard,
  });

  const handleChatSend = async (text: string) => {
    const scopeKey = chatScopeKey;
    const cameraId = selectedCamera;
    const history = chatMessages.slice(-8);
    const updateScopedChat = (updater: (messages: ChatMessage[]) => ChatMessage[]) => {
      updateScopedChatMessages(scopeKey, updater);
    };
    const setLastAssistant = (reply: string) => {
      updateScopedChat(prev => prev.length > 0
        ? [...prev.slice(0, -1), { role: "assistant", text: reply }]
        : [{ role: "assistant", text: reply }]);
    };

    updateScopedChat(prev => [
      ...prev,
      { role: "user", text },
      { role: "assistant", text: "Reading dashboard state..." },
    ]);
    try {
      const resp = await fetch("/api/dashboard/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "text/event-stream", ...dashboardAuthHeaders(session) },
        body: JSON.stringify({
          prompt: text,
          camera_id: cameraId,
          history,
          session_id: session.sessionId,
          user_id: session.userId,
          stream: true,
        }),
      });
      const contentType = resp.headers.get("content-type") ?? "";
      if (resp.ok && resp.body && contentType.includes("text/event-stream")) {
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let streamedText = "";
        let errorText = "";
        while (true) {
          const { value, done } = await reader.read();
          buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
          const blocks = buffer.split(/\n\n/);
          buffer = blocks.pop() ?? "";
          for (const block of blocks) {
            const event = parseSseEvent(block);
            if (!event) continue;
            if (event.type === "status" && !streamedText) {
              setLastAssistant(event.message);
            } else if (event.type === "delta") {
              streamedText += event.text;
              setLastAssistant(streamedText);
            } else if (event.type === "done") {
              if (!streamedText && event.answer) setLastAssistant(event.answer);
            } else if (event.type === "error") {
              errorText = event.error;
            }
          }
          if (done) break;
        }
        if (errorText) setLastAssistant(resolveDashboardChatReply(undefined, errorText));
        return;
      }
      const data = await resp.json().catch(() => ({})) as { answer?: string; error?: string };
      setLastAssistant(resolveDashboardChatReply(resp.ok ? data.answer : undefined, data.error));
    } catch {
      setLastAssistant(resolveDashboardChatReply(undefined, undefined));
    }
  };

  // Resolve filter label for FilterBar.
  const filterLabel = useMemo(() => {
    switch (selection.kind) {
      case "none":
        return undefined;
      case "entity":
        return aliases.nameOf(selection.entity_id);
      case "segment": {
        const seg = segments.find(s => s.segment_id === selection.segment_id);
        if (!seg) return "Segment";
        return `Segment ${formatSegmentLabelTime(seg)}`;
      }
      case "rule":
        return "Rule";
    }
  }, [selection, aliases, segments]);

  // Cross-column entity filter: resolves the current selection to the set of
  // entity_ids that should stay bright in the entity panel.
  // - segment: use the selected segment's `entity_ids`
  // - rule: union of entity_ids across every segment the rule triggered on
  // - entity/none: `undefined` — EntityPanel handles these cases itself
  const selectedEntityIds = useMemo<Set<string> | undefined>(() => {
    if (selection.kind === "segment") {
      const seg = segmentsWithRules.find(s => s.segment_id === selection.segment_id);
      return new Set(seg?.entity_ids ?? []);
    }
    if (selection.kind === "rule") {
      const ids = new Set<string>();
      for (const seg of segmentsWithRules) {
        if (!seg.triggered_rules.includes(selection.rule_id)) continue;
        for (const id of seg.entity_ids) ids.add(id);
      }
      return ids;
    }
    return undefined;
  }, [selection, segmentsWithRules]);

  const toggleEntities = () => {
    setEntityPanelOpen((current) => {
      const next = !current;
      setEntityPanelCollapsedBySource((prev) => ({ ...prev, [entityPanelSourceKey]: !next }));
      return next;
    });
  };

  const toggleMemory = () => {
    setMemoryPanelOpen((current) => !current);
  };

  const handleClearDashboard = async () => {
    if (clearingDashboard) return;
    const confirmed = window.confirm("Clear uploaded videos and all current Moments / Entity data?");
    if (!confirmed) return;
    setClearingDashboard(true);
    try {
      const resp = await fetch("/api/dashboard/clear", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...dashboardAuthHeaders(session) },
        body: JSON.stringify({ session_id: session.sessionId, user_id: session.userId }),
      });
      const data = await resp.json() as { ok?: boolean; error?: string };
      if (!resp.ok || data.ok !== true) {
        throw new Error(data.error ?? `POST /api/dashboard/clear failed: ${resp.status}`);
      }
      window.localStorage.removeItem("reflectworld.entity.aliases.v1");
      window.sessionStorage.removeItem(SELECTED_SOURCE_STORAGE_KEY);
      window.location.reload();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Failed to clear dashboard data");
      setClearingDashboard(false);
    }
  };

  if (admission.status === "checking") {
    return <SessionGate title="Preparing Dashboard" message="Starting your demo session..." />;
  }
  if (admission.status === "full") {
    return (
      <SessionGate
        title="Demo Capacity Is Full"
        message={admission.message}
        detail={admission.maxActiveSessions ? `Current limit: ${admission.maxActiveSessions} active sessions.` : undefined}
      />
    );
  }
  if (admission.status === "error") {
    return <SessionGate title="Dashboard Session Failed" message={admission.message} />;
  }

  const rightPanelOpen = entityPanelOpen || memoryPanelOpen;
  const rightInsightsPanel = (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      {entityPanelOpen && (
        <div
          style={{
            flex: memoryPanelOpen ? "0 0 auto" : "1 1 0",
            maxHeight: memoryPanelOpen ? "50%" : undefined,
            minHeight: 0,
            overflowY: memoryPanelOpen ? "auto" : "hidden",
            overflowX: "hidden",
            padding: memoryPanelOpen ? "2px 8px 4px 2px" : undefined,
            boxSizing: "border-box",
            scrollbarGutter: memoryPanelOpen ? "stable" : undefined,
          }}
        >
          <EntityPanel
            entities={aliases.ordered}
            sightingsMap={sightingsMap}
            camerasMap={camerasMap}
            activityMap={activityMap}
            semanticMap={semanticMap}
            sightingsGalleryMap={sightingsGalleryMap}
            selection={selection}
            onSelectEntity={selectEntity}
            onClearFilter={clear}
            filterLabel={filterLabel}
            selectedEntityIds={selectedEntityIds}
            fillHeight={!memoryPanelOpen}
          />
        </div>
      )}
      {entityPanelOpen && memoryPanelOpen && (
        <div
          aria-hidden="true"
          style={{
            height: 1,
            flex: "0 0 auto",
            margin: "12px 2px 12px",
            background: "linear-gradient(90deg, transparent, rgba(31,45,71,0.16), transparent)",
          }}
        />
      )}
      {memoryPanelOpen && (
        <div
          style={{
            flex: "1 1 0",
            minHeight: 0,
            overflow: "hidden",
            padding: "2px 8px 4px 2px",
            boxSizing: "border-box",
          }}
        >
          <MemoryPanel
            sceneMemories={memoryPanelData.sceneMemories}
            eventGroups={memoryPanelData.eventGroups}
          />
        </div>
      )}
    </div>
  );

  const entitiesToggleButton = (
    <>
      <button
        type="button"
        onClick={toggleEntities}
        aria-pressed={entityPanelOpen}
        aria-label={entityPanelOpen ? "Hide entity panel" : "Show entity panel"}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          padding: "5px 12px",
          borderRadius: tokens.radius.pill,
          fontSize: 11,
          fontWeight: 500,
          cursor: "pointer",
          border: "none",
          fontFamily: "inherit",
          background: entityPanelOpen ? tokens.accent.soft : tokens.bg.inset,
          color: entityPanelOpen ? tokens.accent.base : tokens.text.secondary,
        }}
      >
        <Icon name="users" size={14} /> Entity
      </button>
      <button
        type="button"
        onClick={toggleMemory}
        aria-pressed={memoryPanelOpen}
        aria-label={memoryPanelOpen ? "Hide memory panel" : "Show memory panel"}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          padding: "5px 12px",
          borderRadius: tokens.radius.pill,
          fontSize: 11,
          fontWeight: 500,
          cursor: "pointer",
          border: "none",
          fontFamily: "inherit",
          background: memoryPanelOpen ? tokens.accent.soft : tokens.bg.inset,
          color: memoryPanelOpen ? tokens.accent.base : tokens.text.secondary,
        }}
      >
        <Icon name="brain" size={14} /> Memory
      </button>
    </>
  );

  return (
    <>
      <IconSprite />
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          height: "100vh",
          background: tokens.bg.page,
          color: tokens.text.primary,
          fontFamily: tokens.font.sans,
        }}
      >
        <TopBar
          connected={connected}
          analysisStatus={analysisStatus}
          rulesSlot={
            <RulesButton
              rules={rules}
              selection={selection}
              session={session}
              onSelectRule={selectRule}
              onRuleDeleted={markDeleted}
            />
          }
          userId={session.userId}
          isAdmin={session.isAdmin}
          clearing={clearingDashboard}
          onClearDashboard={handleClearDashboard}
          onOpenSettings={() => setSettingsOpen(true)}
        />
        <MainLayout
          entitiesCollapsed={!rightPanelOpen}
          sidebar={
            <Sidebar
              events={visibleEvents}
              analyses={visibleAnalyses}
              selectedCamera={selectedCamera}
              onSelectCamera={setSelectedCamera}
              session={session}
              chatMessages={chatMessages}
              chatContextLabel={chatContextLabel}
              chatSuggestions={chatSuggestions}
              onChatClear={() => setChatMessagesBySource(prev => ({ ...prev, [chatScopeKey]: [] }))}
              onChatSend={handleChatSend}
              pendingRemovedSourceIds={pendingRemovedSourceIds}
              onSourceRemovePendingChange={setSourceRemovePending}
              chatVoice={{
                enabled: liveAgent.enabled,
                hotkey: liveAgent.hotkey,
                state: liveAgent.state,
                error: liveAgent.error,
                interactive: liveAgent.interactive,
                audioLevel: liveAgent.audioLevel,
                onToggle: liveAgent.toggle,
              }}
            />
          }
          center={
            <SegmentList
              segments={segmentsWithRules}
              selection={selection}
              timelineEnabled={!rightPanelOpen}
              onSelectSegment={selectSegment}
              onClearFilter={clear}
              rightSlot={entitiesToggleButton}
              getEntityName={aliases.nameOf}
              filterLabel={filterLabel}
              sourceLabel={
                selectedCamera
                  ? mediaSourceLabels.get(selectedCamera)
                    ?? segmentsWithRules.find(segment => segment.camera_id === selectedCamera)?.source_label
                  : undefined
              }
            />
          }
          entities={rightInsightsPanel}
        />
        <BottomBar events={visibleEvents} segments={segmentsWithRules} />
      </div>
      <SettingsOverlay open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </>
  );
}
