import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { monitorBus, writeStderr } from "@cortex/shared";
import type {
  ActiveSourceStatus,
  DashboardBoundingBox,
  DashboardEntityRefMap,
  DashboardRefEntityMap,
  DashboardSegmentState,
  DashboardSegmentTarget,
  DashboardStateEnvelope,
  FrameDetection,
  MonitorEvent,
  Segment,
} from "@cortex/shared";
import { projectDialogueEvents } from "../dialogue-events.js";
import type { PipelineLogEntry, PipelineStore } from "../store.js";
import {
  dashboardRawReadLimit,
  parseDashboardJson,
  type AnalysisStatusSnapshot,
  type DashboardSessionScope,
} from "./dashboard-common.js";

interface DashboardSourceLabel {
  label: string;
  isMediaSource: boolean;
}

function looksLikeVideoSource(value: unknown): boolean {
  return typeof value === "string" && /\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(value.trim());
}

export interface DashboardSegmentProjectorOptions {
  store: PipelineStore | null;
  stateDir: string;
  sessionEnabled: () => boolean;
  getAnalysisStatus: () => AnalysisStatusSnapshot;
  sourceVisibleToSession: (sourceId: string, scope?: DashboardSessionScope | null) => boolean;
  visibleSourceStatusesSync: (scope?: DashboardSessionScope | null) => ActiveSourceStatus[];
  sourceLabel: (source: ActiveSourceStatus) => string;
  broadcastEnvelope: (envelope: DashboardStateEnvelope) => void;
  nextDashboardVersion: () => number;
}

export class DashboardSegmentProjector {
  private readonly pendingSegmentProjection = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly partialSegmentStates = new Map<string, DashboardSegmentState>();
  private readonly activeWatchingPreviewByCamera = new Map<string, string>();
  private readonly activeStaticGaps = new Map<string, DashboardSegmentState>();

  constructor(private readonly options: DashboardSegmentProjectorOptions) {}

  stop(): void {
    for (const timer of this.pendingSegmentProjection.values()) {
      clearTimeout(timer);
    }
    this.pendingSegmentProjection.clear();
  }

  clearActiveStaticGap(cameraId: string): void {
    this.activeStaticGaps.delete(cameraId);
  }

  clearWatchingPreviews(cameraId: string): void {
    this.clearPartialSegments(cameraId, (segment) => segment.vlm_model === "watching-preview");
  }

  clearPartialSegmentsForCamera(cameraId: string): void {
    this.clearPartialSegments(cameraId);
  }

  getPartialSegmentStates(): Map<string, DashboardSegmentState> {
    return this.partialSegmentStates;
  }

  buildRecentSegmentEvents(limit: number, cameraId?: string, scope?: DashboardSessionScope | null): MonitorEvent[] {
    return this.buildDashboardSegments(limit, cameraId, scope)
      .map((segment) => this.segmentStateEvent(segment));
  }

  buildDashboardSegments(limit: number, cameraId?: string, scope?: DashboardSessionScope | null): DashboardSegmentState[] {
    const partialSegments = Array.from(this.partialSegmentStates.values())
      .filter((segment) => (!cameraId || segment.camera_id === cameraId) && this.options.sourceVisibleToSession(segment.camera_id, scope));
    const store = this.options.store;
    if (!store) {
      return partialSegments
        .sort((a, b) => (b.sort_time ?? b.start_time) - (a.sort_time ?? a.start_time))
        .slice(0, limit);
    }
    const rawLimit = this.options.sessionEnabled() && scope && !scope.isAdmin && !cameraId
      ? dashboardRawReadLimit(limit)
      : limit;
    const rows = store
      .getRecent(cameraId, rawLimit)
      .filter((row) => this.options.sourceVisibleToSession(row.camera_id, scope));
    const sourceLabels = this.sourceLabels(scope);
    const segments: DashboardSegmentState[] = [];
    const lastStaticByCamera = new Map<string, number>();
    const refEntityMap = this.buildRefEntityMap(rows);
    for (const row of [...rows].reverse()) {
      const segment = this.segmentFromRow(row, sourceLabels, refEntityMap);
      if (this.shouldProjectStaticGap(segment)) {
        segment.timeline_type = "static_gap";
        segment.segment_id = this.staticGapId(segment.camera_id, segment.start_time);
        segment.event_id = segment.segment_id;
        segment.summary = "Static Scene";
        segment.detailed_summary = "No meaningful activity was detected during this period.";
        segment.gif_url = null;
        segment.keyframe_url = null;
        segment.clip_url = null;
        segment.targets = [];
        segment.entity_refs = [];
        segment.entity_ids = [];
      }
      if (segment.timeline_type === "static_gap") {
        const prevIdx = lastStaticByCamera.get(segment.camera_id);
        const prev = prevIdx !== undefined ? segments[prevIdx] : undefined;
        if (prev?.timeline_type === "static_gap") {
          this.extendStaticGap(prev, segment);
          continue;
        }
        lastStaticByCamera.set(segment.camera_id, segments.length);
      } else {
        lastStaticByCamera.delete(segment.camera_id);
      }
      segments.push(segment);
    }
    const finalSegments = segments.reverse();
    const finalSegmentIds = new Set(finalSegments.map((segment) => segment.segment_id));
    const timelineStart = (segment: DashboardSegmentState): number => (
      segment.display_time_mode === "media" ? segment.display_start_time ?? segment.start_time : segment.start_time
    );
    const timelineEnd = (segment: DashboardSegmentState): number => (
      segment.display_time_mode === "media" ? segment.display_end_time ?? segment.end_time : segment.end_time
    );
    const coveredByFinalSegment = (partial: DashboardSegmentState): boolean => finalSegments.some((segment) => (
      segment.camera_id === partial.camera_id
      && timelineStart(partial) >= timelineStart(segment)
      && timelineEnd(partial) <= timelineEnd(segment)
    ));
    return [
      ...partialSegments.filter((segment) => !finalSegmentIds.has(segment.segment_id) && !coveredByFinalSegment(segment)),
      ...finalSegments,
    ]
      .sort((a, b) => (b.sort_time ?? b.start_time) - (a.sort_time ?? a.start_time))
      .slice(0, limit);
  }

  sourceLabels(scope?: DashboardSessionScope | null): Map<string, DashboardSourceLabel> {
    const labels = new Map<string, DashboardSourceLabel>();
    for (const source of this.options.visibleSourceStatusesSync(scope)) {
      labels.set(source.source_id, {
        label: this.options.sourceLabel(source),
        isMediaSource: source.protocol === "file" || Boolean(source.video_id) || source.source_id.startsWith("video-"),
      });
    }
    const snapshot = this.options.getAnalysisStatus();
    for (const item of [...snapshot.recent, ...snapshot.active]) {
      if (!this.options.sourceVisibleToSession(item.camera_id, scope) || labels.has(item.camera_id)) continue;
      labels.set(item.camera_id, {
        label: this.normalizeSourceLabel(item.video_id || item.camera_id),
        isMediaSource: true,
      });
    }
    return labels;
  }

  readSourceConfig(cameraId: string): Record<string, unknown> | null {
    const safeCameraId = cameraId.trim();
    if (!safeCameraId || safeCameraId.includes("/") || safeCameraId.includes("\\")) return null;
    const path = join(this.options.stateDir, "sources", `${safeCameraId}.json`);
    if (!existsSync(path)) return null;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
    } catch {
      return null;
    }
  }

  buildEntityRefMap(limit: number, cameraId?: string, scope?: DashboardSessionScope | null): DashboardEntityRefMap {
    const store = this.options.store;
    if (!store) return {};
    const rawLimit = this.options.sessionEnabled() && scope && !scope.isAdmin && !cameraId
      ? dashboardRawReadLimit(limit)
      : limit;
    const rows = store
      .getRecent(cameraId, rawLimit)
      .filter((row) => this.options.sourceVisibleToSession(row.camera_id, scope))
      .slice(0, limit);
    const out: DashboardEntityRefMap = {};
    for (const row of rows) {
      for (const raw of parseDashboardJson<unknown[]>(row.entities_json, [])) {
        if (!raw || typeof raw !== "object") continue;
        const target = raw as Record<string, unknown>;
        const entityId = typeof target.entity_id === "string" && target.entity_id ? target.entity_id : "";
        if (!entityId || out[entityId]) continue;
        const rawType = typeof target.type === "string"
          ? target.type
          : typeof target.class_name === "string"
            ? target.class_name
            : "unknown";
        const normalizedType = rawType.toLowerCase();
        const subjectIndex = typeof target.subject_index === "number" && Number.isFinite(target.subject_index)
          ? Math.max(1, Math.floor(target.subject_index))
          : undefined;
        const ref = this.targetRef(target, normalizedType, subjectIndex);
        if (ref) out[entityId] = ref;
      }
    }
    return out;
  }

  mediaUrl(absPath: string | undefined | null): string | null {
    if (!absPath) return null;
    const marker = "/media/";
    const idx = absPath.indexOf(marker);
    if (idx < 0) return null;
    return `/media/${absPath.slice(idx + marker.length)}`;
  }

  stateEnvelope(segment: DashboardSegmentState, version: number): DashboardStateEnvelope {
    return this.segmentStateEnvelope(segment, version);
  }

  publishPartialSegmentState(event: MonitorEvent): void {
    try {
      const data = event.data;
      const segmentId = typeof data.segment_id === "string" ? data.segment_id : "";
      const cameraId = typeof data.camera_id === "string"
        ? data.camera_id
        : typeof event.camera_id === "string"
          ? event.camera_id
          : "";
      const startTime = typeof data.segment_start === "number" ? data.segment_start : undefined;
      const durationSec = typeof data.duration_sec === "number" ? data.duration_sec : 0;
      const field = typeof data.field === "string" ? data.field : "";
      const partialReceivedAt = typeof data.partial_received_at === "number" ? data.partial_received_at : event.timestamp;
      const analysisStartedAt = typeof data.analysis_started_at === "number" ? data.analysis_started_at : undefined;
      const partialRefreshMs = typeof data.partial_refresh_ms === "number"
        ? data.partial_refresh_ms
        : analysisStartedAt === undefined
          ? undefined
          : partialReceivedAt - analysisStartedAt;
      const summaryRefreshMs = typeof data.summary_refresh_ms === "number" ? data.summary_refresh_ms : undefined;
      const vlmTtftMs = typeof data.vlm_ttft_ms === "number" ? data.vlm_ttft_ms : undefined;
      const vlmFirstContentMs = typeof data.vlm_first_content_ms === "number" ? data.vlm_first_content_ms : undefined;
      if (!segmentId || !cameraId || startTime === undefined) return;

      const sourceMeta = this.sourceLabels().get(cameraId);
      const isMediaSource = sourceMeta?.isMediaSource === true || cameraId.startsWith("video-");
      const existing = this.partialSegmentStates.get(segmentId);
      const segment: DashboardSegmentState = existing ? { ...existing } : {
        timeline_type: "segment",
        segment_id: segmentId,
        event_id: typeof data.event_id === "string" ? data.event_id : segmentId,
        camera_id: cameraId,
        source_label: sourceMeta?.label ?? this.normalizeSourceLabel(cameraId),
        is_media_source: isMediaSource,
        mode: typeof data.mode === "string" ? data.mode : "event",
        start_time: startTime,
        end_time: startTime + Math.max(0, durationSec) * 1000,
        sort_time: startTime,
        display_start_time: startTime,
        display_end_time: startTime + Math.max(0, durationSec) * 1000,
        display_time_mode: isMediaSource ? "media" : "wall_clock",
        duration_sec: Math.max(0, durationSec),
        title: undefined,
        summary: "Analyzing segment...",
        detailed_summary: "The segment is being analyzed. Full results will replace this preview.",
        gif_url: null,
        keyframe_url: null,
        is_static: false,
        merged_count: 1,
        targets: [],
        entity_refs: [],
        entity_ids: [],
        triggered_rules: [],
        triggered_rule_labels: [],
        notification_fired: false,
        security_risk: false,
        notification_reasons: [],
        segment_policy_prompt: null,
        transcript: null,
        dialogue: [],
        clip_url: null,
        analysis_status: "partial",
        is_partial: true,
        partial_received_at: partialReceivedAt,
        analysis_started_at: analysisStartedAt,
        partial_refresh_ms: partialRefreshMs,
        summary_refresh_ms: summaryRefreshMs,
        vlm_ttft_ms: vlmTtftMs,
        vlm_first_content_ms: vlmFirstContentMs,
      };

      const value = data.value;
      if (field === "title") {
        const title = typeof value === "string" ? value.trim() : "";
        if (!title) return;
        segment.title = title;
      } else if (field === "summary") {
        const summary = typeof value === "string" ? value.trim() : "";
        if (!summary) return;
        segment.summary = summary;
        segment.detailed_summary = summary;
      } else if (field === "security_risk") {
        if (typeof value !== "boolean") return;
        segment.security_risk = value;
      } else if (field === "security_reason") {
        const reason = typeof value === "string" ? value.trim() : "";
        if (!reason) return;
        segment.notification_reasons = [reason];
      } else if (field === "notify_user") {
        if (typeof value !== "boolean") return;
        segment.notification_fired = value || segment.notification_fired;
      } else if (field === "matched_rule_ids") {
        if (!Array.isArray(value)) return;
        segment.triggered_rules = value.filter((id): id is string => typeof id === "string" && id.length > 0);
      } else if (field === "dialogue") {
        const rawDialogue: Record<string, unknown> = {};
        if (typeof data.transcript === "string" && data.transcript.trim()) {
          rawDialogue.transcript = data.transcript.trim();
        }
        if (Array.isArray(value)) rawDialogue.dialogue = value;
        const { speech_events_text: _speechEventsText, ...dialogue } = projectDialogueEvents(rawDialogue, segment.targets);
        const hasTranscript = typeof dialogue.transcript === "string" && dialogue.transcript.trim();
        const hasDialogue = Array.isArray(dialogue.dialogue) && dialogue.dialogue.length > 0;
        if (!hasTranscript && !hasDialogue) return;
        segment.transcript = hasTranscript ? dialogue.transcript as string : segment.transcript;
        segment.dialogue = hasDialogue ? dialogue.dialogue as DashboardSegmentState["dialogue"] : [];
      } else {
        return;
      }

      segment.analysis_status = "partial";
      segment.is_partial = true;
      segment.vlm_model = "processing-preview";
      if (!segment.title || segment.title === this.segmentPreviewTitle("watching-preview") || segment.title === this.segmentPreviewTitle("queued-preview")) {
        segment.title = this.segmentPreviewTitle("processing-preview");
      }
      segment.partial_received_at = segment.partial_received_at ?? partialReceivedAt;
      segment.analysis_started_at = segment.analysis_started_at ?? analysisStartedAt;
      segment.partial_refresh_ms = segment.partial_refresh_ms ?? partialRefreshMs;
      if (field === "summary") segment.summary_refresh_ms = segment.summary_refresh_ms ?? summaryRefreshMs ?? partialRefreshMs;
      segment.vlm_ttft_ms = segment.vlm_ttft_ms ?? vlmTtftMs;
      segment.vlm_first_content_ms = segment.vlm_first_content_ms ?? vlmFirstContentMs;
      if (this.activeWatchingPreviewByCamera.get(cameraId) === segmentId) {
        this.activeWatchingPreviewByCamera.delete(cameraId);
      }
      this.partialSegmentStates.set(segmentId, segment);
      this.options.broadcastEnvelope(this.segmentStateEnvelope(segment, this.options.nextDashboardVersion()));
    } catch (err) {
      writeStderr("[dashboard-state] partial segment projection failed", err);
    }
  }

  publishSegmentState(segmentId: string): void {
    const store = this.options.store;
    if (!store) return;
    const existing = this.pendingSegmentProjection.get(segmentId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.pendingSegmentProjection.delete(segmentId);
      try {
        const row = store.getBySegmentId(segmentId);
        if (!row) return;
        const sourceLabels = this.sourceLabels();
        const recentRows = store.getRecent(row.camera_id, 100);
        const segment = this.segmentFromRow(row, sourceLabels, this.buildRefEntityMap(recentRows));
        this.partialSegmentStates.delete(segmentId);
        if (this.activeWatchingPreviewByCamera.get(segment.camera_id) === segmentId) {
          this.activeWatchingPreviewByCamera.delete(segment.camera_id);
        }
        if (this.shouldProjectStaticGap(segment)) {
          this.options.broadcastEnvelope(this.segmentRemoveEnvelope(segmentId, segment.camera_id, segment.start_time, this.options.nextDashboardVersion()));
          const existing = this.activeStaticGaps.get(segment.camera_id);
          if (existing) {
            this.extendStaticGap(existing, segment);
            this.options.broadcastEnvelope(this.segmentStateEnvelope(existing, this.options.nextDashboardVersion()));
            return;
          }
          segment.timeline_type = "static_gap";
          segment.segment_id = this.staticGapId(segment.camera_id, segment.start_time);
          segment.event_id = segment.segment_id;
          segment.summary = "Static Scene";
          segment.detailed_summary = "No meaningful activity was detected during this period.";
          segment.gif_url = null;
          segment.keyframe_url = null;
          segment.clip_url = null;
          segment.targets = [];
          segment.entity_refs = [];
          segment.entity_ids = [];
          this.activeStaticGaps.set(segment.camera_id, segment);
          this.options.broadcastEnvelope(this.segmentStateEnvelope(segment, this.options.nextDashboardVersion()));
          return;
        }
        this.activeStaticGaps.delete(segment.camera_id);
        this.options.broadcastEnvelope(this.segmentStateEnvelope(segment, this.options.nextDashboardVersion()));
      } catch (err) {
        writeStderr("[dashboard-state] segment projection failed", err);
      }
    }, 50);
    this.pendingSegmentProjection.set(segmentId, timer);
  }

  publishWatchingPreview(req: {
    segmentId: string;
    cameraId: string;
    timestamp: number;
    currentTimestamp?: number;
    frameBase64?: string;
    detections: FrameDetection[];
    inputMode?: "local_file" | "live_stream";
  }): void {
    const cameraId = req.cameraId.trim();
    const segmentId = req.segmentId.trim();
    if (!cameraId || !segmentId) return;
    this.closeActiveWatchingPreview(cameraId, segmentId);
    const sourceMeta = this.sourceLabels().get(cameraId);
    let keyframePath: string | undefined;
    const store = this.options.store;
    if (store && req.frameBase64) {
      try {
        keyframePath = store.saveMedia(cameraId, segmentId, "keyframe", Buffer.from(req.frameBase64, "base64"), "latest");
      } catch (err) {
        writeStderr("[dashboard-state] segment watching preview keyframe save failed", err);
      }
    }
    const keyframeUrl = this.mediaUrl(keyframePath);
    const targets = this.detectionTargets(req.detections);
    const entityIds = this.targetEntityIds(targets);
    const entityRefs = this.targetEntityRefs(targets);
    const isLiveLike = req.inputMode === "live_stream";
    const sourceIsMediaSource = sourceMeta?.isMediaSource === true || cameraId.startsWith("video-");
    const mediaSortTime = Number.isFinite(req.timestamp) ? req.timestamp : Date.now();
    const isStreamUpload = isLiveLike && sourceIsMediaSource;
    const mediaCurrentTime = typeof req.currentTimestamp === "number" && Number.isFinite(req.currentTimestamp)
      ? req.currentTimestamp
      : mediaSortTime;
    const existing = this.partialSegmentStates.get(segmentId);
    const startTime = isLiveLike
      ? existing?.start_time ?? Date.now()
      : Number.isFinite(req.timestamp)
        ? req.timestamp
        : Date.now();
    const sortTime = isStreamUpload ? mediaSortTime : startTime;
    const isMediaSource = isLiveLike ? false : sourceIsMediaSource;
    const displayStartTime = isStreamUpload
      ? existing?.display_start_time ?? mediaSortTime
      : startTime;
    const displayEndTime = isStreamUpload
      ? Math.max(displayStartTime, mediaCurrentTime)
      : startTime + 1000;
    const durationSec = isStreamUpload
      ? Math.max(1, (displayEndTime - displayStartTime) / 1000)
      : 1;
    const state: DashboardSegmentState = {
      timeline_type: "segment",
      segment_id: segmentId,
      event_id: segmentId,
      camera_id: cameraId,
      source_label: sourceMeta?.label ?? this.normalizeSourceLabel(cameraId),
      is_media_source: isMediaSource,
      mode: "stream",
      vlm_model: "watching-preview",
      title: this.segmentPreviewTitle("watching-preview"),
      start_time: startTime,
      end_time: startTime + durationSec * 1000,
      sort_time: sortTime,
      display_start_time: displayStartTime,
      display_end_time: displayEndTime,
      display_time_mode: isStreamUpload || isMediaSource ? "media" : "wall_clock",
      duration_sec: durationSec,
      summary: "Watching the scene...",
      detailed_summary: isMediaSource
        ? "Segmenting uploaded video frames. This card will update when analysis completes."
        : "Watching the live stream. This card will update when the segment is cut.",
      gif_url: null,
      keyframe_url: keyframeUrl,
      is_static: false,
      merged_count: 1,
      targets,
      entity_refs: entityRefs,
      entity_ids: entityIds,
      triggered_rules: [],
      triggered_rule_labels: [],
      notification_fired: false,
      security_risk: false,
      notification_reasons: [],
      segment_policy_prompt: null,
      transcript: null,
      dialogue: [],
      clip_url: null,
      analysis_status: "partial",
      is_partial: true,
      partial_received_at: Date.now(),
    };
    this.activeWatchingPreviewByCamera.set(cameraId, segmentId);
    this.partialSegmentStates.set(segmentId, state);
    this.options.broadcastEnvelope(this.segmentStateEnvelope(state, this.options.nextDashboardVersion()));
  }

  publishQueuedPreview(segment: Segment): void {
    if (this.activeWatchingPreviewByCamera.get(segment.camera_id) === segment.segment_id) {
      this.activeWatchingPreviewByCamera.delete(segment.camera_id);
    }
    const state = this.buildCutSegmentPreview(segment, "queued-preview");
    if (!state) return;
    this.partialSegmentStates.set(segment.segment_id, state);
    this.options.broadcastEnvelope(this.segmentStateEnvelope(state, this.options.nextDashboardVersion()));
  }

  publishProcessingPreview(segment: Segment, gifPath?: string): void {
    if (this.activeWatchingPreviewByCamera.get(segment.camera_id) === segment.segment_id) {
      this.activeWatchingPreviewByCamera.delete(segment.camera_id);
    }
    if (gifPath) {
      const existing = this.partialSegmentStates.get(segment.segment_id);
      if (!existing || existing.vlm_model !== "processing-preview") return;
      const state: DashboardSegmentState = {
        ...existing,
        gif_url: this.mediaUrl(gifPath),
        partial_received_at: Date.now(),
      };
      this.partialSegmentStates.set(segment.segment_id, state);
      this.options.broadcastEnvelope(this.segmentStateEnvelope(state, this.options.nextDashboardVersion()));
      return;
    }
    const state = this.buildCutSegmentPreview(segment, "processing-preview", gifPath);
    if (!state) return;
    this.partialSegmentStates.set(segment.segment_id, state);
    this.options.broadcastEnvelope(this.segmentStateEnvelope(state, this.options.nextDashboardVersion()));
  }

  publishSkippedPreview(
    segment: Segment,
    info: { reason: string; lagMs: number; thresholdMs: number; skippedTotal?: number },
  ): void {
    if (this.activeWatchingPreviewByCamera.get(segment.camera_id) === segment.segment_id) {
      this.activeWatchingPreviewByCamera.delete(segment.camera_id);
    }
    const base = this.partialSegmentStates.get(segment.segment_id)
      ?? this.buildCutSegmentPreview(segment, "queued-preview");
    if (!base) return;
    const lagSec = Math.round(info.lagMs / 1000);
    const thresholdSec = Math.round(info.thresholdMs / 1000);
    const state: DashboardSegmentState = {
      ...base,
      vlm_model: "backlog-skip",
      title: "Skipped",
      summary: "Perception skipped this segment because analysis fell behind live video.",
      detailed_summary: `Perception backlog lag reached ${lagSec}s, exceeding the ${thresholdSec}s threshold. ` +
        "The video remains recorded on disk, but detailed VLM analysis was skipped to catch up.",
      analysis_status: "skipped",
      is_partial: false,
      partial_received_at: Date.now(),
    };
    this.partialSegmentStates.delete(segment.segment_id);
    this.options.broadcastEnvelope(this.segmentStateEnvelope(state, this.options.nextDashboardVersion()));
  }

  private closeActiveWatchingPreview(cameraId: string, nextSegmentId?: string): void {
    const activeSegmentId = this.activeWatchingPreviewByCamera.get(cameraId);
    if (!activeSegmentId || activeSegmentId === nextSegmentId) return;
    this.activeWatchingPreviewByCamera.delete(cameraId);
    const existing = this.partialSegmentStates.get(activeSegmentId);
    if (!existing || existing.vlm_model !== "watching-preview") return;
    const queued = this.freezeWatchingPreviewAsQueued(existing);
    this.partialSegmentStates.set(activeSegmentId, queued);
    this.options.broadcastEnvelope(this.segmentStateEnvelope(queued, this.options.nextDashboardVersion()));
  }

  private clearPartialSegments(
    cameraId: string,
    predicate: (segment: DashboardSegmentState) => boolean = () => true,
  ): void {
    const sourceId = cameraId.trim();
    if (!sourceId) return;
    for (const [segmentId, segment] of Array.from(this.partialSegmentStates.entries())) {
      if (segment.camera_id !== sourceId || !predicate(segment)) continue;
      this.partialSegmentStates.delete(segmentId);
      if (this.activeWatchingPreviewByCamera.get(sourceId) === segmentId) {
        this.activeWatchingPreviewByCamera.delete(sourceId);
      }
      this.options.broadcastEnvelope(this.segmentRemoveEnvelope(
        segmentId,
        sourceId,
        segment.start_time,
        this.options.nextDashboardVersion(),
      ));
    }
  }

  private freezeWatchingPreviewAsQueued(segment: DashboardSegmentState): DashboardSegmentState {
    const displayStart = segment.display_start_time ?? segment.start_time;
    const displayEnd = segment.display_end_time ?? segment.end_time;
    const fixedDurationSec = Math.max(
      1,
      segment.duration_sec,
      (Math.max(displayEnd, displayStart) - displayStart) / 1000,
      (Math.max(segment.end_time, segment.start_time) - segment.start_time) / 1000,
    );
    const endTime = segment.start_time + fixedDurationSec * 1000;
    return {
      ...segment,
      vlm_model: "queued-preview",
      title: this.segmentPreviewTitle("queued-preview"),
      end_time: endTime,
      display_end_time: displayStart + fixedDurationSec * 1000,
      duration_sec: fixedDurationSec,
      summary: "Segment cut. Waiting for analysis.",
      detailed_summary: "This segment has been cut and is waiting for Perception analysis.",
      partial_received_at: Date.now(),
    };
  }

  private buildCutSegmentPreview(segment: Segment, model: "queued-preview" | "processing-preview", gifPath?: string): DashboardSegmentState | null {
    if (!segment.segment_id || !segment.camera_id) return null;
    const sourceMeta = this.sourceLabels().get(segment.camera_id);
    const previewFrame = this.segmentPreviewFrame(segment);
    const detections = this.segmentPreviewDetections(segment);
    let keyframePath: string | undefined;
    const store = this.options.store;
    if (store && previewFrame?.data) {
      try {
        keyframePath = store.saveMedia(segment.camera_id, segment.segment_id, "keyframe", Buffer.from(previewFrame.data, "base64"), "preview");
      } catch (err) {
        writeStderr("[dashboard-state] segment processing preview keyframe save failed", err);
      }
    }
    const keyframeUrl = this.mediaUrl(keyframePath);
    const targets = this.detectionTargets(detections);
    const entityIds = this.targetEntityIds(targets);
    const entityRefs = this.targetEntityRefs(targets);
    const durationSec = Math.max(0, Number.isFinite(segment.duration_sec) ? segment.duration_sec : 0);
    const inputMode = (segment as Segment & { _input_mode?: string })._input_mode;
    const isLiveLike = inputMode === "live_stream";
    const sourceIsMediaSource = sourceMeta?.isMediaSource === true || inputMode === "local_file" || segment.camera_id.startsWith("video-");
    const mediaStartTime = Number.isFinite(segment.timestamp) ? segment.timestamp : Date.now();
    const isStreamUpload = isLiveLike && sourceIsMediaSource;
    const startTime = isLiveLike
      ? Date.now() - durationSec * 1000
      : mediaStartTime;
    const sortTime = isStreamUpload ? mediaStartTime : startTime;
    const isMediaSource = isLiveLike ? false : sourceIsMediaSource;
    const displayStartTime = isStreamUpload ? mediaStartTime : startTime;
    const displayEndTime = displayStartTime + durationSec * 1000;
    return {
      timeline_type: "segment",
      segment_id: segment.segment_id,
      event_id: segment.segment_id,
      camera_id: segment.camera_id,
      source_label: sourceMeta?.label ?? this.normalizeSourceLabel(segment.camera_id),
      is_media_source: isMediaSource,
      mode: segment.mode,
      vlm_model: model,
      title: this.segmentPreviewTitle(model),
      start_time: startTime,
      end_time: startTime + durationSec * 1000,
      sort_time: sortTime,
      display_start_time: displayStartTime,
      display_end_time: displayEndTime,
      display_time_mode: isStreamUpload || isMediaSource ? "media" : "wall_clock",
      duration_sec: durationSec,
      summary: detections.length > 0
        ? this.summarizeDetectionCategories(detections)
        : model === "queued-preview"
          ? "Segment cut. Waiting for analysis."
          : "Analyzing segment...",
      detailed_summary: model === "queued-preview"
        ? "This segment has been cut and is waiting for Perception analysis."
        : isMediaSource
          ? "This segment has entered Perception. Full analysis will replace this preview."
          : "The segment is being analyzed. Full results will replace this preview.",
      gif_url: model === "processing-preview" ? this.mediaUrl(gifPath) : null,
      keyframe_url: keyframeUrl,
      is_static: false,
      merged_count: 1,
      targets,
      entity_refs: entityRefs,
      entity_ids: entityIds,
      triggered_rules: [],
      triggered_rule_labels: [],
      notification_fired: false,
      security_risk: false,
      notification_reasons: [],
      segment_policy_prompt: null,
      transcript: null,
      dialogue: [],
      clip_url: null,
      analysis_status: "partial",
      is_partial: true,
      partial_received_at: Date.now(),
    };
  }

  private segmentStateEnvelope(segment: DashboardSegmentState, version: number): DashboardStateEnvelope {
    return {
      domain: "segment",
      id: segment.segment_id,
      version,
      op: "upsert",
      timestamp: segment.start_time,
      data: { ...segment },
    };
  }

  private segmentStateEvent(segment: DashboardSegmentState): MonitorEvent {
    return {
      type: "dashboard:segment_state",
      timestamp: segment.sort_time ?? segment.start_time,
      camera_id: segment.camera_id,
      data: {
        ...segment,
        _synthetic: true,
      },
    };
  }

  private segmentRemoveEnvelope(segmentId: string, cameraId: string, timestamp: number, version: number): DashboardStateEnvelope {
    return {
      domain: "segment",
      id: segmentId,
      version,
      op: "remove",
      timestamp,
      data: {
        segment_id: segmentId,
        camera_id: cameraId,
        op: "remove",
      },
    };
  }

  private staticGapId(cameraId: string, startTime: number): string {
    return `static_gap:${cameraId}:${Math.floor(startTime)}`;
  }

  private shouldProjectStaticGap(segment: DashboardSegmentState): boolean {
    return segment.vlm_model === "local-idle-skip" && !segment.is_media_source;
  }

  private extendStaticGap(target: DashboardSegmentState, next: DashboardSegmentState): void {
    const startTime = Math.min(target.start_time, next.start_time);
    const rangeEndTime = Math.max(target.end_time, next.end_time);
    const rangeDurationSec = Math.max(0, (rangeEndTime - startTime) / 1000);
    const accumulatedDurationSec = Math.max(0, target.duration_sec) + Math.max(0, next.duration_sec);
    target.start_time = startTime;
    target.duration_sec = Math.max(rangeDurationSec, accumulatedDurationSec);
    target.end_time = startTime + target.duration_sec * 1000;
    target.merged_count += next.merged_count;
  }

  private normalizeSourceLabel(raw: string): string {
    const trimmed = raw.trim();
    if (!trimmed) return trimmed;
    const parts = trimmed.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] ?? trimmed;
  }

  private targetId(target: Record<string, unknown>): string | undefined {
    return typeof target.target_id === "string" && target.target_id
      ? target.target_id
      : typeof target.track_id === "string" && target.track_id
        ? target.track_id
        : undefined;
  }

  private targetRef(target: Record<string, unknown>, normalizedType: string, subjectIndex?: number): string | undefined {
    return subjectIndex ? `${normalizedType || "object"}:${subjectIndex}` : this.targetId(target);
  }

  private buildRefEntityMap(rows: PipelineLogEntry[]): DashboardRefEntityMap {
    const entityToRef: DashboardEntityRefMap = {};
    const refToEntity = new Map<string, string>();
    const conflictedRefs = new Set<string>();
    for (const row of rows) {
      for (const raw of parseDashboardJson<unknown[]>(row.entities_json, [])) {
        if (!raw || typeof raw !== "object") continue;
        const target = raw as Record<string, unknown>;
        const entityId = typeof target.entity_id === "string" && target.entity_id ? target.entity_id : "";
        if (!entityId || entityToRef[entityId]) continue;
        const rawType = typeof target.type === "string"
          ? target.type
          : typeof target.class_name === "string"
            ? target.class_name
            : "unknown";
        const normalizedType = rawType.toLowerCase();
        const subjectIndex = typeof target.subject_index === "number" && Number.isFinite(target.subject_index)
          ? Math.max(1, Math.floor(target.subject_index))
          : undefined;
        const ref = this.targetRef(target, normalizedType, subjectIndex);
        if (!ref) continue;
        entityToRef[entityId] = ref;
        const existing = refToEntity.get(ref);
        if (existing && existing !== entityId) {
          conflictedRefs.add(ref);
          continue;
        }
        refToEntity.set(ref, entityId);
      }
    }
    for (const ref of conflictedRefs) refToEntity.delete(ref);
    return Object.fromEntries(refToEntity.entries());
  }

  private boundingBox(raw: unknown): DashboardBoundingBox | undefined {
    if (!raw || typeof raw !== "object") return undefined;
    const box = raw as Record<string, unknown>;
    const x = typeof box.x === "number" ? box.x : undefined;
    const y = typeof box.y === "number" ? box.y : undefined;
    const width = typeof box.width === "number" ? box.width : undefined;
    const height = typeof box.height === "number" ? box.height : undefined;
    if (x === undefined || y === undefined || width === undefined || height === undefined) return undefined;
    return { x, y, width, height };
  }

  private segmentTargets(raw: unknown, refEntityMap?: DashboardRefEntityMap): DashboardSegmentTarget[] {
    if (!Array.isArray(raw)) return [];
    const out: DashboardSegmentTarget[] = [];
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const target = item as Record<string, unknown>;
      const rawType = typeof target.type === "string"
        ? target.type
        : typeof target.class_name === "string"
          ? target.class_name
          : "unknown";
      const subjectIndex = typeof target.subject_index === "number" && Number.isFinite(target.subject_index)
        ? Math.max(1, Math.floor(target.subject_index))
        : undefined;
      const explicitName = [
        typeof target.name === "string" ? target.name.trim() : "",
        typeof target.person_name === "string" ? target.person_name.trim() : "",
        typeof target.identity === "string" ? target.identity.trim() : "",
      ].find((value) => value && !/^unknown$/i.test(value));
      const normalizedType = rawType.toLowerCase();
      const fallbackPrefix = normalizedType === "person"
        ? "Person"
        : normalizedType === "dog"
          ? "Dog"
          : normalizedType === "cat"
            ? "Cat"
            : normalizedType === "car" || normalizedType === "vehicle"
              ? "Car"
              : normalizedType ? normalizedType[0]!.toUpperCase() + normalizedType.slice(1) : "Object";
      const label = explicitName || (subjectIndex ? `${fallbackPrefix} ${subjectIndex}` : undefined);
      const targetId = this.targetId(target);
      const displayRef = this.targetRef(target, normalizedType, subjectIndex);
      const explicitEntityId = typeof target.entity_id === "string" && target.entity_id ? target.entity_id : "";
      const entityId = explicitEntityId || (displayRef ? refEntityMap?.[displayRef] ?? "" : "");
      const bbox = this.boundingBox(target.bbox);
      const faceBbox = this.boundingBox(target.face_bbox);
      out.push({
        ...(entityId ? { entity_id: entityId } : {}),
        ...(targetId ? { target_id: targetId } : {}),
        type: normalizedType,
        ...(typeof target.name === "string" && target.name.trim() ? { name: target.name.trim() } : {}),
        ...(subjectIndex ? { subject_index: subjectIndex } : {}),
        ...(displayRef ? { ref: displayRef } : {}),
        ...(label ? { label } : {}),
        has_name: Boolean(explicitName),
        ...(typeof target.first_seen === "string" || typeof target.first_seen === "number" ? { first_seen: target.first_seen } : {}),
        ...(typeof target.person_name === "string" && target.person_name.trim() ? { person_name: target.person_name.trim() } : {}),
        ...(typeof target.identity === "string" && target.identity.trim() ? { identity: target.identity.trim() } : {}),
        ...(typeof target.is_new === "boolean"
          ? { is_new: target.is_new }
          : typeof target.is_new_entity === "boolean"
            ? { is_new: target.is_new_entity }
            : {}),
        appearance: typeof target.appearance === "string" ? target.appearance : "",
        behavior: typeof target.behavior === "string" ? target.behavior : "",
        ...(bbox ? { bbox } : {}),
        ...(faceBbox ? { face_bbox: faceBbox } : {}),
        ...(typeof target.face_quality === "number" ? { face_quality: target.face_quality } : {}),
        ...(typeof target.face_yaw === "number" ? { face_yaw: target.face_yaw } : {}),
        ...(typeof target.face_pitch === "number" ? { face_pitch: target.face_pitch } : {}),
        ...(typeof target.avatar_score === "number" ? { avatar_score: target.avatar_score } : {}),
        ...(typeof target.keyframe_path === "string" && target.keyframe_path ? { keyframe_path: target.keyframe_path } : {}),
        ...(typeof target.crop_path === "string" && target.crop_path ? { crop_path: target.crop_path } : {}),
      });
    }
    return out;
  }

  private targetEntityIds(targets: DashboardSegmentTarget[]): string[] {
    return Array.from(new Set(targets.flatMap((target) => target.entity_id ? [target.entity_id] : [])));
  }

  private targetEntityRefs(targets: DashboardSegmentTarget[]): string[] {
    return Array.from(new Set(targets.flatMap((target) => {
      if (target.ref === undefined || target.ref === null) return [];
      const ref = String(target.ref).trim();
      return ref ? [ref] : [];
    })));
  }

  private segmentFromRow(
    row: PipelineLogEntry,
    sourceLabels: Map<string, DashboardSourceLabel>,
    refEntityMap?: DashboardRefEntityMap,
  ): DashboardSegmentState {
    const media = parseDashboardJson<{ gif?: string; keyframes?: string[] }>(row.media_urls_json, {});
    const dialogue = this.segmentDialogue(row);
    const targets = this.segmentTargets(parseDashboardJson<unknown[]>(row.entities_json, []), refEntityMap);
    const entityIds = this.targetEntityIds(targets);
    const entityRefs = this.targetEntityRefs(targets);
    const notificationReasons = this.options.store?.getNotificationMessages(row.segment_id) ?? [];
    const matchedRuleIds = parseDashboardJson<string[]>(row.matched_rule_ids_json, [])
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    const sourceMeta = sourceLabels.get(row.camera_id);
    const sourceLabel = sourceMeta?.label ?? this.normalizeSourceLabel(row.camera_id);
    const isMediaSource = sourceMeta?.isMediaSource === true
      || row.camera_id.startsWith("video-")
      || looksLikeVideoSource(sourceLabel);
    const createdAtMs = new Date(`${row.created_at}Z`).getTime();
    let timestamp = row.segment_start ?? createdAtMs;
    let durationSec = row.duration_sec;
    const liveTimelineDrift = !isMediaSource
      && (timestamp < 1_000_000_000_000 || durationSec > 86_400);
    if (liveTimelineDrift) {
      timestamp = Number.isFinite(createdAtMs) ? createdAtMs : Date.now();
      durationSec = Number.isFinite(row.duration_sec) && row.duration_sec >= 0 && row.duration_sec <= 86_400
        ? row.duration_sec
        : row.frame_count > 1 ? Math.max(0, row.frame_count - 1) : 0;
    }
    const isStatic = row.is_static_scene === 1;
    const keyframePath = Array.isArray(media.keyframes) ? media.keyframes[0] : undefined;
    return {
      timeline_type: "segment",
      segment_id: row.segment_id,
      event_id: row.event_id ?? "",
      camera_id: row.camera_id,
      source_label: sourceLabel,
      is_media_source: isMediaSource,
      mode: row.mode,
      vlm_model: row.vlm_model ?? undefined,
      start_time: timestamp,
      end_time: timestamp + durationSec * 1000,
      sort_time: timestamp,
      display_start_time: timestamp,
      display_end_time: timestamp + durationSec * 1000,
      display_time_mode: isMediaSource ? "media" : "wall_clock",
      duration_sec: durationSec,
      title: isStatic ? "Static Scene" : row.title?.trim() || undefined,
      summary: row.summary,
      detailed_summary: row.detailed_summary?.trim() || row.summary,
      gif_url: this.mediaUrl(media.gif),
      keyframe_url: this.mediaUrl(keyframePath),
      is_static: isStatic,
      merged_count: 1,
      targets,
      entity_refs: entityRefs,
      entity_ids: entityIds,
      triggered_rules: matchedRuleIds,
      triggered_rule_labels: [],
      notification_fired: row.notify_user === 1 || notificationReasons.length > 0,
      security_risk: Boolean(row.security_risk),
      notification_reasons: notificationReasons,
      segment_policy_prompt: null,
      transcript: typeof dialogue.transcript === "string" && dialogue.transcript.trim() ? dialogue.transcript.trim() : null,
      dialogue: Array.isArray(dialogue.dialogue) ? dialogue.dialogue : [],
      clip_url: row.mode === "snapshot" ? null : `/api/segment/${row.segment_id}/clip`,
      analysis_status: "final",
      is_partial: false,
    };
  }

  private segmentDialogue(row: PipelineLogEntry): Record<string, unknown> {
    const fromDb = parseDashboardJson<Record<string, unknown>>(row.dialogue_json, {});
    if (Object.keys(fromDb).length > 0) return this.sanitizeSegmentDialogue(row, fromDb);

    const archivePath = join(this.options.stateDir, "segments", `${row.segment_id}.json`);
    if (!existsSync(archivePath)) return {};
    try {
      const archive = JSON.parse(readFileSync(archivePath, "utf8")) as Record<string, unknown>;
      const dialogue: Record<string, unknown> = {};
      if (typeof archive.transcript === "string" && archive.transcript.trim()) {
        dialogue.transcript = archive.transcript.trim();
      }
      if (Array.isArray(archive.dialogue) && archive.dialogue.length > 0) dialogue.dialogue = archive.dialogue;
      return this.sanitizeSegmentDialogue(row, dialogue);
    } catch {
      return {};
    }
  }

  private sanitizeSegmentDialogue(row: PipelineLogEntry, raw: Record<string, unknown>): Record<string, unknown> {
    const targets = this.segmentTargets(parseDashboardJson<unknown[]>(row.entities_json, []));
    const { speech_events_text: _speechEventsText, ...dialogue } = projectDialogueEvents(raw, targets);
    return dialogue;
  }

  private normalizeDetectionLabel(label: string): string {
    const normalized = label.trim().toLowerCase();
    if (normalized === "human") return "person";
    if (normalized === "vehicle" || normalized === "truck" || normalized === "bus" || normalized === "motorcycle") return "car";
    if (normalized === "dog" || normalized === "cat") return normalized;
    return normalized || "object";
  }

  private summarizeDetectionCategories(detections: FrameDetection[]): string {
    const categories = new Set<string>();
    for (const detection of detections) {
      const label = this.normalizeDetectionLabel(detection.label);
      if (label === "person") categories.add("people");
      else if (label === "car") categories.add("vehicles");
      else if (label === "pet") categories.add("animals");
    }
    const labels = [...categories].sort((a, b) => {
      const order = ["people", "vehicles", "animals"];
      return order.indexOf(a) - order.indexOf(b);
    });
    return labels.length > 0
      ? `Seeing ${labels.join(", ")}.`
      : "Watching the scene...";
  }

  private detectionTargets(detections: FrameDetection[]): DashboardSegmentTarget[] {
    return detections
      .filter((d) => d.confidence >= 0.35)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 8)
      .map((d, index) => {
        const type = this.normalizeDetectionLabel(d.label);
        const x = Math.max(0, d.bbox.x1);
        const y = Math.max(0, d.bbox.y1);
        const width = Math.max(0, d.bbox.x2 - d.bbox.x1);
        const height = Math.max(0, d.bbox.y2 - d.bbox.y1);
        return {
          target_id: `preview-${index + 1}`,
          type,
          appearance: `${type} detected in the current frame`,
          behavior: "Waiting for full analysis",
          bbox: { x, y, width, height },
        };
      });
  }

  private segmentPreviewTitle(model: "watching-preview" | "queued-preview" | "processing-preview"): string {
    if (model === "watching-preview") return "Watching";
    if (model === "queued-preview") return "Waiting for analysis";
    return "Analyzing...";
  }

  private segmentPreviewFrame(segment: Segment): Segment["frames"][number] | undefined {
    if (segment.frames.length === 0) return undefined;
    let best = segment.frames[Math.floor(segment.frames.length / 2)];
    let bestScore = -1;
    for (const frame of segment.frames) {
      const detections = frame.detections ?? [];
      const score = detections.reduce((sum, d) => sum + Math.max(0, d.confidence), 0);
      if (score > bestScore) {
        best = frame;
        bestScore = score;
      }
    }
    return best;
  }

  private segmentPreviewDetections(segment: Segment): FrameDetection[] {
    return this.segmentPreviewFrame(segment)?.detections ?? [];
  }
}
