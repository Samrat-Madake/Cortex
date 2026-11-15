import { useMemo } from "react";
import type {
  DashboardBoundingBox,
  DashboardSegmentDialogueLine,
  DashboardSegmentState,
  DashboardSegmentTarget,
} from "@cortex/shared";
import type { MonitorEvent } from "../types";

export type BoundingBox = DashboardBoundingBox;
export type SegmentTarget = DashboardSegmentTarget;

export type SegmentDialogueLine = DashboardSegmentDialogueLine;

export type Segment = DashboardSegmentState;

/** Maximum number of segments surfaced to the UI — matches prior MemoryMonitor cap. */
const MAX_SEGMENTS = 300;

function normalizeSourceLabel(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  const parts = trimmed.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? trimmed;
}

/**
 * Convert an absolute server-side keyframe path to a monitor-served `/media/...` URL.
 * Returns null when the path is missing or does not contain a `/media/` marker.
 */
function toMediaUrl(absPath: string | undefined | null): string | null {
  if (!absPath) return null;
  const marker = "/media/";
  const idx = absPath.indexOf(marker);
  if (idx < 0) return null;
  return `/media/${absPath.slice(idx + marker.length)}`;
}

interface RawMainTarget {
  type?: unknown;
  class_name?: unknown;
  appearance?: unknown;
  behavior?: unknown;
  bbox?: unknown;
  face_bbox?: unknown;
  face_quality?: unknown;
  face_yaw?: unknown;
  face_pitch?: unknown;
  avatar_score?: unknown;
  entity_id?: unknown;
  target_id?: unknown;
  name?: unknown;
  subject_index?: unknown;
  label?: unknown;
  ref?: unknown;
  has_name?: unknown;
  first_seen?: unknown;
  person_name?: unknown;
  identity?: unknown;
  is_new?: unknown;
  keyframe_path?: unknown;
  crop_path?: unknown;
}

function parseBbox(raw: unknown): BoundingBox | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const b = raw as Record<string, unknown>;
  const x = typeof b.x === "number" ? b.x : undefined;
  const y = typeof b.y === "number" ? b.y : undefined;
  const width = typeof b.width === "number" ? b.width : undefined;
  const height = typeof b.height === "number" ? b.height : undefined;
  if (x === undefined || y === undefined || width === undefined || height === undefined) return undefined;
  return { x, y, width, height };
}

function extractJsonObject(text: string): string | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  return text.slice(start, end + 1);
}

function extractStringField(text: string, fieldNames: string[]): string | undefined {
  for (const field of fieldNames) {
    const escapedField = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = text.match(new RegExp(`"${escapedField}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)`, "i"));
    const raw = match?.[1];
    if (!raw) continue;
    try {
      return JSON.parse(`"${raw}"`) as string;
    } catch {
      return raw.replace(/\\"/g, "\"").replace(/\\n/g, "\n").trim();
    }
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function formatAdaptivePerceptionPrompt(data: Record<string, unknown>): string | null {
  const params = asRecord(data.suggested_params) ?? asRecord(data.tool_details);
  const config =
    asRecord(data.suggested_config)
    ?? asRecord(params?.config)
    ?? null;
  if (!config) return null;

  const sections: string[] = [];
  const labels: Record<string, string> = {
    scene_description: "Scene description",
    focus_targets: "Focus targets",
    security_rules: "Security rules",
  };
  for (const key of ["scene_description", "focus_targets", "security_rules"]) {
    const value = config[key];
    if (typeof value === "string" && value.trim()) {
      sections.push(`${labels[key]}:\n${value.trim()}`);
    } else if (Array.isArray(value)) {
      const items = value
        .map((item) => typeof item === "string" ? item.trim() : "")
        .filter(Boolean);
      if (items.length > 0) sections.push(`${labels[key]}:\n${items.map((item) => `- ${item}`).join("\n")}`);
    }
  }
  if (sections.length === 0) return null;

  const exitCondition = data.exit_condition;
  if (exitCondition !== undefined) {
    sections.push(`Exit condition:\n${JSON.stringify(exitCondition)}`);
  }
  return sections.join("\n\n");
}

function stripJsonishText(text: string): string {
  return text
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .replace(/^\s*\{+/, "")
    .replace(/\}+\s*$/, "")
    .trim();
}

function normalizeSummary(raw: unknown): string {
  const text = String(raw ?? "").trim();
  if (!text) return "";

  const candidates = [
    text,
    text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim(),
    extractJsonObject(text),
  ].filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      const summary = parsed.summary ?? parsed.short_summary ?? parsed.shortSummary;
      if (typeof summary === "string" && summary.trim()) return summary.trim();
    } catch {
      // Try loose field extraction below.
    }
  }

  return (
    extractStringField(text, ["summary", "short_summary", "shortSummary"]) ??
    stripJsonishText(text)
  );
}

function parseTargets(mainTargets: unknown): SegmentTarget[] {
  if (!Array.isArray(mainTargets)) return [];
  const out: SegmentTarget[] = [];
  for (const raw of mainTargets) {
    if (!raw || typeof raw !== "object") continue;
    const t = raw as RawMainTarget;
    const rawType = typeof t.type === "string" ? t.type : typeof t.class_name === "string" ? t.class_name : "unknown";
    const type = rawType.toLowerCase();
    out.push({
      entity_id: typeof t.entity_id === "string" && t.entity_id ? t.entity_id : undefined,
      target_id: typeof t.target_id === "string" && t.target_id ? t.target_id : undefined,
      type,
      name: typeof t.name === "string" && t.name.trim() ? t.name.trim() : undefined,
      subject_index: typeof t.subject_index === "number" && Number.isFinite(t.subject_index) ? t.subject_index : undefined,
      label: typeof t.label === "string" && t.label.trim() ? t.label.trim() : undefined,
      ref: typeof t.ref === "string" || typeof t.ref === "number" ? t.ref : undefined,
      has_name: typeof t.has_name === "boolean" ? t.has_name : undefined,
      first_seen: typeof t.first_seen === "string" || typeof t.first_seen === "number" ? t.first_seen : undefined,
      person_name: typeof t.person_name === "string" && t.person_name.trim() ? t.person_name.trim() : undefined,
      identity: typeof t.identity === "string" && t.identity.trim() ? t.identity.trim() : undefined,
      is_new: typeof t.is_new === "boolean" ? t.is_new : undefined,
      appearance: typeof t.appearance === "string" ? t.appearance : "",
      behavior: typeof t.behavior === "string" ? t.behavior : "",
      bbox: parseBbox(t.bbox),
      face_bbox: parseBbox(t.face_bbox),
      face_quality: typeof t.face_quality === "number" ? t.face_quality : undefined,
      face_yaw: typeof t.face_yaw === "number" ? t.face_yaw : undefined,
      face_pitch: typeof t.face_pitch === "number" ? t.face_pitch : undefined,
      avatar_score: typeof t.avatar_score === "number" ? t.avatar_score : undefined,
      keyframe_path: typeof t.keyframe_path === "string" ? t.keyframe_path : undefined,
      crop_path: typeof t.crop_path === "string" ? t.crop_path : undefined,
    });
  }
  return out;
}

function parseDialogue(raw: unknown): SegmentDialogueLine[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item) => ({
      text_start: typeof item.text_start === "number" ? item.text_start : undefined,
      speaker: typeof item.speaker === "string" && item.speaker.trim() ? item.speaker.trim() : undefined,
      track_id: typeof item.track_id === "string" && item.track_id.trim() ? item.track_id.trim() : undefined,
      entity_id: typeof item.entity_id === "string" && item.entity_id.trim() ? item.entity_id.trim() : undefined,
      confidence: typeof item.confidence === "string" ? item.confidence : undefined,
      text: typeof item.text === "string" ? item.text : undefined,
    }))
    .filter((item) => Boolean(item.text || item.speaker));
}

function readString(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key];
  return typeof value === "string" ? value : undefined;
}

function readNumber(data: Record<string, unknown>, key: string): number | undefined {
  const value = data[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readStringArray(data: Record<string, unknown>, key: string): string[] {
  const value = data[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function parseCanonicalSegment(e: MonitorEvent): Segment | null {
  const data = e.data;
  const segment_id = readString(data, "segment_id");
  const camera_id = readString(data, "camera_id") ?? e.camera_id ?? "";
  const start_time = readNumber(data, "start_time");
  const end_time = readNumber(data, "end_time");
  const sort_time = readNumber(data, "sort_time");
  const display_start_time = readNumber(data, "display_start_time");
  const display_end_time = readNumber(data, "display_end_time");
  const display_time_mode = data.display_time_mode === "media" || data.display_time_mode === "wall_clock"
    ? data.display_time_mode
    : undefined;
  if (!segment_id || !camera_id || start_time === undefined || end_time === undefined) return null;
  const is_static = data.is_static === true;
  const timeline_type = data.timeline_type === "static_gap" ? "static_gap" : "segment";
  const isStaticGap = timeline_type === "static_gap";
  const targets = isStaticGap ? [] : parseTargets(data.targets);
  const entityIds = readStringArray(data, "entity_ids");
  const entityRefs = readStringArray(data, "entity_refs");
  return {
    timeline_type,
    segment_id,
    event_id: readString(data, "event_id") ?? "",
    camera_id,
    source_label: readString(data, "source_label") ?? normalizeSourceLabel(camera_id),
    is_media_source: data.is_media_source === true,
    mode: readString(data, "mode") ?? "event",
    start_time,
    end_time,
    sort_time: sort_time ?? start_time,
    display_start_time,
    display_end_time,
    display_time_mode,
    duration_sec: readNumber(data, "duration_sec") ?? Math.max(0, (end_time - start_time) / 1000),
    vlm_model: readString(data, "vlm_model"),
    title: readString(data, "title") ?? undefined,
    summary: readString(data, "summary") ?? "",
    detailed_summary: readString(data, "detailed_summary") ?? readString(data, "summary") ?? "",
    gif_url: isStaticGap ? null : (readString(data, "gif_url") ?? null),
    keyframe_url: isStaticGap ? null : (readString(data, "keyframe_url") ?? null),
    is_static,
    merged_count: readNumber(data, "merged_count") ?? 1,
    targets,
    entity_refs: entityRefs.length > 0
      ? entityRefs
      : Array.from(new Set(targets.flatMap((target) => target.ref !== undefined && target.ref !== null ? [String(target.ref)] : []))),
    entity_ids: entityIds.length > 0
      ? entityIds
      : Array.from(new Set(targets.flatMap((target) => target.entity_id ? [target.entity_id] : []))),
    triggered_rules: readStringArray(data, "triggered_rules"),
    triggered_rule_labels: readStringArray(data, "triggered_rule_labels"),
    notification_fired: data.notification_fired === true,
    security_risk: data.security_risk === true,
    notification_reasons: readStringArray(data, "notification_reasons"),
    segment_policy_prompt: readString(data, "segment_policy_prompt") ?? null,
    transcript: readString(data, "transcript") ?? null,
    dialogue: parseDialogue(data.dialogue),
    clip_url: isStaticGap ? null : (readString(data, "clip_url") ?? null),
    analysis_status: data.analysis_status === "partial"
      ? "partial"
      : data.analysis_status === "final"
        ? "final"
        : data.analysis_status === "skipped"
          ? "skipped"
          : undefined,
    is_partial: data.is_partial === true,
    partial_received_at: readNumber(data, "partial_received_at"),
    analysis_started_at: readNumber(data, "analysis_started_at"),
    partial_refresh_ms: readNumber(data, "partial_refresh_ms"),
    summary_refresh_ms: readNumber(data, "summary_refresh_ms"),
    vlm_ttft_ms: readNumber(data, "vlm_ttft_ms"),
    vlm_first_content_ms: readNumber(data, "vlm_first_content_ms"),
  };
}

/**
 * Derive displayable `Segment[]` from the event stream.
 *
 * Processing rules (ported from `center/MemoryMonitor.tsx:extractEpisodicEntries`):
 * 1. Filter to `memory:memory_added` events whose `memory_type === "episodic"` (or missing for legacy).
 * 2. Merge consecutive static segments per camera into a single range.
 * 3. Cap at MAX_SEGMENTS entries, newest-first (event stream is already newest-first).
 * 4. For non-static segments, join the latest matching `perception:vlm_result` by `segment_id`
 *    to populate `targets` and `keyframe_url`.
 */
export function deriveSegments(events: MonitorEvent[]): Segment[] {
    const canonical = events
      .filter((e) => e.type === "dashboard:segment_state")
      .map(parseCanonicalSegment)
      .filter((segment): segment is Segment => Boolean(segment))
      .sort((a, b) => (b.sort_time ?? b.start_time) - (a.sort_time ?? a.start_time))
      .slice(0, MAX_SEGMENTS);

    const sourceLabelByCamera = new Map<string, string>();
    const mediaSourceByCamera = new Map<string, boolean>();
    for (const e of events) {
      const cameraId = e.camera_id ?? (typeof e.data.source_id === "string" ? e.data.source_id : "");
      if (!cameraId) continue;
      if (!mediaSourceByCamera.has(cameraId)) {
        mediaSourceByCamera.set(
          cameraId,
          e.data.protocol === "file" || typeof e.data.video_id === "string" || cameraId.startsWith("video-"),
        );
      }
      if (sourceLabelByCamera.has(cameraId)) continue;
      const sourceName = typeof e.data.source_name === "string"
        ? e.data.source_name
        : typeof e.data.video_id === "string"
          ? e.data.video_id
          : "";
      if (sourceName.trim()) sourceLabelByCamera.set(cameraId, normalizeSourceLabel(sourceName));
    }

    // Build segment_id -> latest VLM result lookup. Events come in newest-first,
    // so the first hit per segment_id is the most recent.
    const vlmBySegment = new Map<string, MonitorEvent>();
    for (const e of events) {
      if (e.type !== "perception:vlm_result") continue;
      const segId = typeof e.data.segment_id === "string" ? e.data.segment_id : "";
      if (!segId) continue;
      if (!vlmBySegment.has(segId)) vlmBySegment.set(segId, e);
    }

    const adaptivePromptBySegment = new Map<string, string>();
    for (const e of events) {
      if (e.type !== "vision_controller:agent_consulted" && e.type !== "vision_controller:consultation_effect_observed") continue;
      const segId = typeof e.data.segment_id === "string" ? e.data.segment_id : "";
      if (!segId || adaptivePromptBySegment.has(segId)) continue;
      const prompt = formatAdaptivePerceptionPrompt(e.data);
      if (prompt) adaptivePromptBySegment.set(segId, prompt);
    }

    const episodic = events.filter(e => {
      if (e.type !== "memory:memory_added") return false;
      const mt = e.data.memory_type;
      return typeof mt === "string" ? mt === "episodic" : true;
    });

    const segments: Segment[] = [];
    // Track per-camera index of the most recent static range so consecutive statics merge.
    const lastStaticByCamera = new Map<string, number>();

    for (const e of episodic) {
      const camera_id = e.camera_id ?? "unknown";
      const is_static = Boolean(e.data.is_static);
      const is_idle_skip = is_static && e.data.vlm_model === "local-idle-skip";
      const isMediaSource = mediaSourceByCamera.get(camera_id) === true;
      const start_time = typeof e.data.segment_start === "number" ? e.data.segment_start : e.timestamp;
      const duration_sec = typeof e.data.duration_sec === "number" ? e.data.duration_sec : 0;
      const end_time = start_time + duration_sec * 1000;
      const segment_id = typeof e.data.segment_id === "string" ? e.data.segment_id : "";
      const event_id = typeof e.data.event_id === "string" ? e.data.event_id : "";
      const mode = typeof e.data.mode === "string" ? e.data.mode : "event";

      if (is_idle_skip && !isMediaSource) {
        const prevIdx = lastStaticByCamera.get(camera_id);
        const prev = prevIdx !== undefined ? segments[prevIdx] : undefined;
        if (prev && prev.is_static) {
          // Merge into existing static range.
          prev.start_time = Math.min(prev.start_time, start_time);
          prev.end_time = Math.max(prev.end_time, end_time);
          prev.duration_sec = (prev.end_time - prev.start_time) / 1000;
          prev.merged_count += 1;
          continue;
        }
        const idx = segments.length;
        segments.push({
          timeline_type: "segment",
          segment_id,
          event_id,
          camera_id,
          source_label: sourceLabelByCamera.get(camera_id) ?? normalizeSourceLabel(camera_id),
          is_media_source: isMediaSource,
          mode,
          start_time,
          end_time,
          duration_sec,
          vlm_model: "local-idle-skip",
          summary: "Static scene — no activity detected.",
          detailed_summary: "Static scene — no activity detected.",
          gif_url: null,
          keyframe_url: null,
          is_static: true,
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
        });
        lastStaticByCamera.set(camera_id, idx);
      } else {
        // Non-static: break the static merge chain for this camera.
        lastStaticByCamera.delete(camera_id);

        const vlmEvent = segment_id ? vlmBySegment.get(segment_id) : undefined;
        const summary = normalizeSummary(e.data.summary_preview ?? e.data.summary ?? "");
        const detailedSummaryRaw = e.data.detailed_summary ?? vlmEvent?.data.detailed_summary;
        const detailed_summary = typeof detailedSummaryRaw === "string" && detailedSummaryRaw.trim()
          ? detailedSummaryRaw.trim()
          : summary;
        const vlmKeyframePath = vlmEvent && typeof vlmEvent.data.keyframe_path === "string"
          ? vlmEvent.data.keyframe_path
          : undefined;
        const vlmGifPath = vlmEvent && typeof vlmEvent.data.gif_path === "string"
          ? vlmEvent.data.gif_path
          : undefined;
        const targets = vlmEvent ? parseTargets(vlmEvent.data.main_targets) : [];

        // Dedupe entity_ids preserving first-seen order.
        const entitySet = new Set<string>();
        const entity_ids: string[] = [];
        const entityRefSet = new Set<string>();
        const entity_refs: string[] = [];
        for (const t of targets) {
          if (t.entity_id && !entitySet.has(t.entity_id)) {
            entitySet.add(t.entity_id);
            entity_ids.push(t.entity_id);
          }
          if (t.ref !== undefined && t.ref !== null) {
            const ref = String(t.ref);
            if (ref && !entityRefSet.has(ref)) {
              entityRefSet.add(ref);
              entity_refs.push(ref);
            }
          }
        }

        const notificationFired = e.data.notification_fired === true;
        const rawReasons = e.data.notification_reasons;
        const notificationReasons: string[] = Array.isArray(rawReasons)
          ? rawReasons.filter((r: unknown) => typeof r === "string")
          : [];
        const securityRisk = vlmEvent?.data.security_risk === true || e.data.security_risk === true;
        const segmentPolicyExitPromptRaw = vlmEvent?.data.segment_policy_prompt ?? e.data.segment_policy_prompt;
        const segmentPolicyExitPrompt = typeof segmentPolicyExitPromptRaw === "string" && segmentPolicyExitPromptRaw.trim()
          ? segmentPolicyExitPromptRaw.trim()
          : null;
        const adaptivePrompt = segment_id ? adaptivePromptBySegment.get(segment_id) ?? null : null;
        const transcriptRaw = vlmEvent?.data.transcript ?? e.data.transcript;

        segments.push({
          timeline_type: "segment",
          segment_id,
          event_id,
          camera_id,
          source_label: sourceLabelByCamera.get(camera_id) ?? normalizeSourceLabel(camera_id),
          is_media_source: isMediaSource,
          mode,
          start_time,
          end_time,
          duration_sec,
          vlm_model: typeof e.data.vlm_model === "string" ? e.data.vlm_model : undefined,
          summary,
          detailed_summary,
          gif_url: toMediaUrl(vlmGifPath),
          keyframe_url: toMediaUrl(vlmKeyframePath),
          is_static,
          merged_count: 1,
          targets,
          entity_refs,
          entity_ids,
          triggered_rules: readStringArray(vlmEvent?.data ?? e.data, "matched_rule_ids"),
          triggered_rule_labels: [],
          notification_fired: notificationFired,
          security_risk: securityRisk,
          notification_reasons: notificationReasons,
          segment_policy_prompt: adaptivePrompt ?? segmentPolicyExitPrompt,
          transcript: typeof transcriptRaw === "string" && transcriptRaw.trim() ? transcriptRaw.trim() : null,
          dialogue: parseDialogue(vlmEvent?.data.dialogue ?? e.data.dialogue),
          clip_url: segment_id && mode !== "snapshot" ? `/api/segment/${segment_id}/clip` : null,
        });
      }

      if (segments.length >= MAX_SEGMENTS) break;
    }

    if (canonical.length > 0) {
      const canonicalIds = new Set(canonical.map((segment) => segment.segment_id));
      const canonicalByCamera = new Map<string, Segment[]>();
      for (const segment of canonical) {
        const bucket = canonicalByCamera.get(segment.camera_id);
        if (bucket) bucket.push(segment);
        else canonicalByCamera.set(segment.camera_id, [segment]);
      }
      const isCoveredByCanonical = (segment: Segment): boolean => (canonicalByCamera.get(segment.camera_id) ?? []).some((existing) => (
        segment.start_time >= existing.start_time &&
        segment.end_time <= existing.end_time
      ));
      return [
        ...canonical,
        ...segments.filter((segment) => !canonicalIds.has(segment.segment_id) && !isCoveredByCanonical(segment)),
      ]
        .sort((a, b) => (b.sort_time ?? b.start_time) - (a.sort_time ?? a.start_time))
        .slice(0, MAX_SEGMENTS);
    }

    return segments;
}

export function useSegments(events: MonitorEvent[]): Segment[] {
  return useMemo(() => deriveSegments(events), [events]);
}
