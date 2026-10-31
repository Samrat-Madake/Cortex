import type { IncomingMessage } from "node:http";
import type { MonitorEvent } from "@reflectworld/shared";

export const DEFAULT_PORT = 3211;
export const VIDEO_EXTENSIONS = new Set([".mp4", ".avi", ".mkv", ".mov", ".webm", ".mpg", ".mpeg", ".flv", ".ts"]);
export const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
export const DEFAULT_MAX_WS_CONNECTIONS = 100;
export const DEFAULT_CHAT_RATE_LIMIT_PER_MIN = 20;
export const DEFAULT_MAX_FFMPEG_JOBS = 4;
export const DEFAULT_MAX_FFMPEG_QUEUE = 32;
export const GO2RTC_STREAMS_CACHE_TTL_MS = 250;
export const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
export const MEMORY_WEBHOOK_EVENT_TYPES = new Set<MonitorEvent["type"]>([
  "memory:memory_added",
  "memory:memory_updated",
  "memory:memory_deleted",
  "memory:identity_set",
]);

export function envFlag(name: string, fallback = false): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

export function envInt(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function envNonNegativeInt(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function envList(name: string): string[] {
  const value = process.env[name];
  if (!value) return [];
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

export function sanitizeSessionToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const safe = value.trim().replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 96);
  return safe || null;
}

export function readCookie(req: IncomingMessage, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (rawKey !== name) continue;
    try {
      return decodeURIComponent(rawValue.join("="));
    } catch {
      return rawValue.join("=");
    }
  }
  return null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isLoopbackRequest(req: IncomingMessage): boolean {
  const remoteAddress = req.socket.remoteAddress;
  return typeof remoteAddress === "string" && LOOPBACK_ADDRESSES.has(remoteAddress);
}

export interface DashboardSessionRecord {
  sessionId: string;
  userId: string;
  isAdmin: boolean;
  createdAt: number;
  lastSeen: number;
  staleSince?: number;
  stopRequested?: boolean;
  hardCleaned?: boolean;
  sources: Set<string>;
}

export interface DashboardSessionConfig {
  enabled: boolean;
  maxActiveSessions: number;
  staleTtlMs: number;
  stopGraceMs: number;
  hardCleanupMs: number;
  maxSourcesPerSession: number;
  adminToken?: string;
}

export interface DashboardSessionScope {
  sessionId: string;
  userId: string;
  isAdmin: boolean;
}

export interface DashboardSecurityConfig {
  publicMode: boolean;
  wsAllowedOrigins: string[];
  maxWsConnections: number;
  chatRateLimitPerMinute: number;
}

export interface DashboardAddSourceOptions {
  userId?: string;
  sessionId?: string;
}

export interface AnalysisStatusItem {
  camera_id: string;
  video_id: string;
  user_id?: string;
  session_id?: string;
  started_at: number;
  completed_at?: number;
  segments_count: number;
  status: "starting" | "active" | "completed" | "failed";
}

export interface AnalysisStatusSnapshot {
  active: AnalysisStatusItem[];
  recent: AnalysisStatusItem[];
}

/** Valid runtime config keys settable from the dashboard. */
export type RuntimeConfigKey =
  | "vlm_model"
  | "analysis_level"
  | "capture_mode"
  | "sampling_rate"
  | "audio_model";

/** In-memory runtime config store. */
export type RuntimeConfig = Record<RuntimeConfigKey, string>;

export const VALID_CONFIG_KEYS = new Set<RuntimeConfigKey>([
  "vlm_model",
  "analysis_level",
  "capture_mode",
  "sampling_rate",
  "audio_model",
]);

export function dashboardRawReadLimit(limit: number): number {
  return Math.min(Math.max(limit * 50, 500), 5000);
}

export function parseDashboardJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Validation rules per config key. Returns error string or null if valid. */
export function validateConfigValue(key: RuntimeConfigKey, value: string): string | null {
  switch (key) {
    case "analysis_level": {
      if (value === "auto") return null;
      const n = parseInt(value, 10);
      if (isNaN(n) || n < 0 || n > 2) return "analysis_level must be 'auto', 0, 1, or 2";
      return null;
    }
    case "sampling_rate": {
      const n = parseFloat(value);
      if (isNaN(n) || n <= 0 || n > 30) return "sampling_rate must be between 0 and 30";
      return null;
    }
    case "capture_mode":
      if (!["stream", "event", "snapshot"].includes(value)) {
        return "capture_mode must be stream, event, or snapshot";
      }
      return null;
    case "vlm_model":
    case "audio_model":
      if (!value || value.length > 200) return `${key} must be a non-empty string (max 200 chars)`;
      return null;
    default:
      return null;
  }
}
