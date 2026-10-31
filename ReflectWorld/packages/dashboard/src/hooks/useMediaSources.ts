import { useMemo } from "react";
import type { MonitorEvent } from "../types";
import type { ActiveAnalysis } from "./useMonitorSocket";

export type MediaSourceKind = "upload" | "live";
export type MediaSourceStatus = "preparing" | "active" | "waiting" | "stopped" | "reconnecting" | "unavailable" | "completed";
export type LiveInputKind = "url" | "web" | "qr" | "unknown";

export interface MediaSourceSession {
  id: string;
  label: string;
  kind: MediaSourceKind;
  isVideo: boolean;
  videoId?: string;
  sourceInput?: string;
  sourceProtocol?: string;
  liveInputKind?: LiveInputKind;
  meta?: string;
  canRemove: boolean;
  canStart?: boolean;
  canStop?: boolean;
  status: MediaSourceStatus;
  mode?: string;
  summary?: string;
  previewUrl?: string;
  createdAt?: number;
  canonical?: boolean;
}

function readString(data: Record<string, unknown>, key: string): string | undefined {
  const v = data[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function readBool(data: Record<string, unknown>, key: string): boolean | undefined {
  const v = data[key];
  return typeof v === "boolean" ? v : undefined;
}

function readNumber(data: Record<string, unknown>, key: string): number | undefined {
  const v = data[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function normalizeSourceLabel(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  const parts = trimmed.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? trimmed;
}

function liveInputKind(input?: string, protocol?: string): LiveInputKind {
  if (protocol === "phone" || input === "phone" || input === "webcam") return "web";
  if (input?.startsWith("rtsp://") || input?.startsWith("http://") || input?.startsWith("https://")) return "url";
  return "unknown";
}

function readStatus(data: Record<string, unknown>): MediaSourceStatus {
  const status = readString(data, "display_status") ?? readString(data, "status");
  if (
    status === "preparing" ||
    status === "active" ||
    status === "waiting" ||
    status === "stopped" ||
    status === "reconnecting" ||
    status === "unavailable" ||
    status === "completed"
  ) {
    return status;
  }
  return "active";
}

function readInputKind(data: Record<string, unknown>): LiveInputKind | undefined {
  const kind = readString(data, "input_kind");
  return kind === "url" || kind === "web" || kind === "qr" || kind === "unknown" ? kind : undefined;
}

export function useMediaSources(events: MonitorEvent[], analyses: ActiveAnalysis[]): MediaSourceSession[] {
  return useMemo(() => deriveMediaSources(events, analyses), [events, analyses]);
}

export function deriveMediaSources(events: MonitorEvent[], _analyses: ActiveAnalysis[]): MediaSourceSession[] {
    const active = new Map<string, MediaSourceSession>();
    const removed = new Set<string>();

    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      const id = e.camera_id ?? readString(e.data, "source_id") ?? readString(e.data, "id");
      if (!id) continue;

      if (e.type !== "dashboard:source_state") continue;
      if (e.data.op === "remove") {
        removed.add(id);
        active.delete(id);
        continue;
      }
      removed.delete(id);
      const kindRaw = readString(e.data, "kind");
      const videoId = readString(e.data, "video_id");
      const sourceInput = readString(e.data, "input");
      const sourceProtocol = readString(e.data, "protocol");
      const isVideo = kindRaw === "upload" || sourceProtocol === "file" || typeof videoId === "string" || id.startsWith("video-");
      const kind: MediaSourceKind = isVideo ? "upload" : "live";
      const inputKind = readInputKind(e.data);
      const label = normalizeSourceLabel(readString(e.data, "label") ?? readString(e.data, "source_name") ?? videoId ?? id);
      active.set(id, {
        id,
        label,
        kind,
        isVideo,
        videoId,
        sourceInput,
        sourceProtocol,
        liveInputKind: isVideo ? undefined : inputKind ?? liveInputKind(sourceInput, sourceProtocol),
        meta: readString(e.data, "last_error"),
        canRemove: readBool(e.data, "can_delete") !== false,
        canStart: readBool(e.data, "can_start") === true,
        canStop: readBool(e.data, "can_stop") === true,
        status: readStatus(e.data),
        mode: readString(e.data, "mode"),
        summary: readString(e.data, "summary"),
        previewUrl: readString(e.data, "preview_url"),
        createdAt: readNumber(e.data, "created_at") ?? e.timestamp,
        canonical: true,
      });
    }

    return Array.from(active.values()).sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}
