import { useMemo } from "react";
import type { MonitorEvent } from "../types";

/** Axis-aligned bounding box — pixel-space, top-left origin. */
export interface SightingBbox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A single visual sighting of an entity, extracted from a VLM result event. */
export interface EntitySighting {
  timestamp: number;
  display_time_mode: "media" | "wall_clock";
  camera_id: string;
  is_media_source: boolean;
  keyframe_url: string | null;
  /** True when keyframe_url is already a backend-generated target crop. */
  image_is_crop: boolean;
  bbox: SightingBbox | null;
  face_bbox: SightingBbox | null;
  face_quality?: number;
  face_yaw?: number;
  face_pitch?: number;
  avatar_score?: number;
  is_new: boolean;
}

/**
 * Convert an absolute server-side keyframe path to a monitor-served `/media/...` URL.
 * Same logic as `useSegments.ts:toMediaUrl`.
 */
function toMediaUrl(absPath: unknown): string | null {
  if (typeof absPath !== "string" || !absPath) return null;
  const marker = "/media/";
  const idx = absPath.indexOf(marker);
  if (idx < 0) return null;
  return `/media/${absPath.slice(idx + marker.length)}`;
}

function parseBbox(raw: unknown): SightingBbox | null {
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Record<string, unknown>;
  const x = typeof b.x === "number" ? b.x : undefined;
  const y = typeof b.y === "number" ? b.y : undefined;
  const width = typeof b.width === "number" ? b.width : undefined;
  const height = typeof b.height === "number" ? b.height : undefined;
  if (x === undefined || y === undefined || width === undefined || height === undefined) return null;
  return { x, y, width, height };
}

function readNumber(data: Record<string, unknown>, key: string): number | undefined {
  const value = data[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function looksLikeVideoSource(value: unknown): boolean {
  return typeof value === "string" && /\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(value.trim());
}

function eventCameraId(e: MonitorEvent): string {
  if (typeof e.camera_id === "string" && e.camera_id) return e.camera_id;
  if (typeof e.data.source_id === "string" && e.data.source_id) return e.data.source_id;
  if (typeof e.data.id === "string" && e.data.id) return e.data.id;
  if (typeof e.data.camera_id === "string" && e.data.camera_id) return e.data.camera_id;
  return "";
}

function eventDeclaresMediaSource(e: MonitorEvent): boolean {
  const cameraId = eventCameraId(e);
  return (
    e.data.is_media_source === true ||
    e.data.protocol === "file" ||
    typeof e.data.video_id === "string" ||
    looksLikeVideoSource(e.data.source_label) ||
    looksLikeVideoSource(e.data.source_name) ||
    looksLikeVideoSource(e.data.input) ||
    cameraId.startsWith("video-")
  );
}

function buildMediaSourceMap(events: MonitorEvent[]): Map<string, boolean> {
  const mediaByCamera = new Map<string, boolean>();
  for (const e of events) {
    const cameraId = eventCameraId(e);
    if (!cameraId) continue;
    if (eventDeclaresMediaSource(e)) {
      mediaByCamera.set(cameraId, true);
    } else if (!mediaByCamera.has(cameraId) && e.type === "dashboard:source_state") {
      mediaByCamera.set(cameraId, false);
    }
  }
  return mediaByCamera;
}

function isMediaTimedSighting(e: MonitorEvent, mediaByCamera: Map<string, boolean>): boolean {
  const cameraId = eventCameraId(e);
  if (e.type === "dashboard:segment_state") {
    return (
      e.data.display_time_mode === "media"
      || e.data.is_media_source === true
      || looksLikeVideoSource(e.data.source_label)
      || looksLikeVideoSource(e.data.video_id)
      || mediaByCamera.get(cameraId) === true
    );
  }
  return (
    eventDeclaresMediaSource(e) ||
    mediaByCamera.get(cameraId) === true
  );
}

function displayTimeMode(e: MonitorEvent, mediaByCamera: Map<string, boolean>): "media" | "wall_clock" {
  return isMediaTimedSighting(e, mediaByCamera) ? "media" : "wall_clock";
}

function getSightingTimestamp(e: MonitorEvent): number {
  if (e.type === "dashboard:segment_state") {
    return readNumber(e.data, "display_start_time")
      ?? readNumber(e.data, "segment_start")
      ?? readNumber(e.data, "start_time")
      ?? e.timestamp;
  }
  return (
    readNumber(e.data, "display_start_time") ??
    readNumber(e.data, "segment_start") ??
    readNumber(e.data, "start_time") ??
    e.timestamp
  );
}

/**
 * Aggregate entity sightings from canonical segment state or legacy
 * `perception:vlm_result` events.
 *
 * For each event, scans targets and groups by stable ReID `entity_id`.
 * Event-local refs such as `person:7` are intentionally ignored.
 * Returns a `Map<entity_id, EntitySighting[]>` with entries sorted newest-first.
 * Each entity's sightings list is capped at 20 entries.
 */
export function deriveEntitySightings(events: MonitorEvent[]): Map<string, EntitySighting[]> {
  const byEntity = new Map<string, EntitySighting[]>();
  const mediaByCamera = buildMediaSourceMap(events);
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
    const camera_id = eventCameraId(e) || "unknown";
    const ts = getSightingTimestamp(e);
    const mode = displayTimeMode(e, mediaByCamera);
    const isMediaSource = mode === "media";
    const mainTargets = e.type === "dashboard:segment_state" ? e.data.targets : e.data.main_targets;
    if (!Array.isArray(mainTargets)) continue;

    for (const raw of mainTargets) {
      if (!raw || typeof raw !== "object") continue;
      const t = raw as Record<string, unknown>;
      const entityId = typeof t.entity_id === "string" && t.entity_id ? t.entity_id : "";
      if (!entityId) continue;
      const cropUrl = toMediaUrl(t.crop_path);
      if (!cropUrl) continue;

      const sighting: EntitySighting = {
        timestamp: ts,
        display_time_mode: mode,
        camera_id,
        is_media_source: isMediaSource,
        keyframe_url: cropUrl,
        image_is_crop: cropUrl !== null,
        bbox: parseBbox(t.bbox),
        face_bbox: parseBbox(t.face_bbox),
        is_new: Boolean(t.is_new),
      };
      if (typeof t.face_quality === "number") sighting.face_quality = t.face_quality;
      if (typeof t.face_yaw === "number") sighting.face_yaw = t.face_yaw;
      if (typeof t.face_pitch === "number") sighting.face_pitch = t.face_pitch;
      if (typeof t.avatar_score === "number") sighting.avatar_score = t.avatar_score;

      if (!byEntity.has(entityId)) byEntity.set(entityId, []);
      byEntity.get(entityId)!.push(sighting);
    }
  }

  // Sort newest-first and cap at 20 per entity.
  for (const list of byEntity.values()) {
    list.sort((a, b) => b.timestamp - a.timestamp);
    if (list.length > 20) list.length = 20;
  }

  return byEntity;
}

export function useEntitySightings(events: MonitorEvent[]): Map<string, EntitySighting[]> {
  return useMemo(() => deriveEntitySightings(events), [events]);
}
