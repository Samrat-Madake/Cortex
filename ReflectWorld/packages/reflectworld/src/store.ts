/**
 * Local SQLite store for pipeline data + media file management.
 *
 * Local filesystem storage:
 * - pipeline_log: perception results
 * - pipeline_errors: error tracking
 * - media_files: local media files with FIFO per-camera quota
 *
 * Uses Node.js built-in node:sqlite (Node 22.5+).
 */
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import {
  mkdirSync,
  existsSync,
  rmSync,
  writeFileSync,
  unlinkSync,
  statSync,
} from "node:fs";
import type { LlmCallRecord, PerceptionResult, Segment, MediaUrls, PipelineTrace } from "@reflectworld/shared";

export type MediaType = "raw" | "keyframe" | "gif" | "crop";

export interface MediaFileEntry {
  id: number;
  segment_id: string;
  camera_id: string;
  media_type: MediaType;
  file_path: string;
  file_size: number;
  created_at: string;
}

export interface PipelineLogEntry {
  id: number;
  segment_id: string;
  camera_id: string;
  mode: string;
  event_id: string | null;
  perception_level: number;
  title: string | null;
  summary: string;
  detailed_summary: string | null;
  security_risk: boolean;
  notify_user: number;
  is_static_scene: number;
  best_frame_index: number | null;
  vlm_model: string | null;
  vlm_latency_ms: number | null;
  entities_json: string | null;
  media_urls_json: string | null;
  dialogue_json: string | null;
  matched_rule_ids_json: string | null;
  raw_url: string | null;
  frame_count: number;
  duration_sec: number;
  segment_start: number | null;
  created_at: string;
}

export interface MemoryWriteFailureEntry {
  id: number;
  segment_id: string;
  camera_id: string;
  user_id: string;
  attempts: number;
  error: string;
  request_json: string;
  created_at: string;
}

export interface SubjectIndexIdentity {
  user_id: string;
  camera_id?: string;
  category: string;
  subject_index: number;
  name?: string;
  entity_id?: string;
  wm_target_id?: string;
  first_seen: number;
  updated_at: number;
}

export interface SubjectIndexSession {
  resolve(input: {
    category: string;
    entity_id?: string;
    wm_target_id?: string;
    subject_index?: number;
    name?: string;
    timestamp?: number;
  }): SubjectIndexIdentity;
  commit(): void;
}

/** Default per-camera quota: 500 MB. */
const DEFAULT_QUOTA_MB = 500;
export const DEFAULT_MEDIA_RETENTION_DAYS = 30;
export const DEFAULT_TEXT_RETENTION_DAYS = 90;
const DAY_MS = 86_400_000;

export interface PipelineRetentionOptions {
  /** Days to keep generated media and local recording references. 0 disables media retention. */
  mediaRetentionDays?: number;
  /** Days to keep local dashboard text/log/trace rows. 0 disables text retention. */
  textRetentionDays?: number;
  /** Test hook; defaults to Date.now(). */
  nowMs?: number;
}

export interface PipelineRetentionExpiredSegment {
  segment_id: string;
  camera_id: string;
}

export interface PipelineRetentionResult {
  mediaRetentionDays: number;
  textRetentionDays: number;
  mediaCutoffMs: number | null;
  textCutoffMs: number | null;
  mediaFilesDeleted: number;
  mediaReferencesExpired: number;
  mediaSegmentsExpired: PipelineRetentionExpiredSegment[];
  pipelineRowsDeleted: number;
  notificationRowsDeleted: number;
  errorRowsDeleted: number;
  traceRowsDeleted: number;
  llmCallRowsDeleted: number;
  memoryWriteFailureRowsDeleted: number;
}

const EXT_MAP: Record<MediaType, string> = {
  raw: "jpg",
  keyframe: "jpg",
  gif: "webp",
  crop: "jpg",
};

function normalizeRetentionDays(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function uniqueRetentionSegments(
  rows: Array<{ segment_id: string; camera_id: string }>,
): PipelineRetentionExpiredSegment[] {
  const seen = new Set<string>();
  const out: PipelineRetentionExpiredSegment[] = [];
  for (const row of rows) {
    if (!row.segment_id || !row.camera_id) continue;
    const key = `${row.camera_id}\u0000${row.segment_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ segment_id: row.segment_id, camera_id: row.camera_id });
  }
  return out;
}

function hasNestedNonEmptyString(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.some(hasNestedNonEmptyString);
  if (!value || typeof value !== "object") return false;
  return Object.values(value).some(hasNestedNonEmptyString);
}

function hasMediaReference(row: { media_urls_json: string | null; raw_url: string | null }): boolean {
  if (row.raw_url?.trim()) return true;
  if (!row.media_urls_json) return false;
  try {
    return hasNestedNonEmptyString(JSON.parse(row.media_urls_json) as unknown);
  } catch {
    return row.media_urls_json.trim().length > 0;
  }
}

export class PipelineStore {
  private db: DatabaseSync;
  private readonly mediaDir: string;
  private readonly quotaBytes: number;
  private readonly traceKeepCount = 500;
  private readonly cleanupIntervalMs = 7 * 86400_000; // 7 days
  private lastTraceCleanupAt = 0;

  constructor(stateDir: string, quotaPerCameraMB = DEFAULT_QUOTA_MB) {
    const dbDir = join(stateDir, "db");
    if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });

    this.mediaDir = join(stateDir, "media");
    if (!existsSync(this.mediaDir)) mkdirSync(this.mediaDir, { recursive: true });

    this.quotaBytes = quotaPerCameraMB * 1024 * 1024;
    this.db = new DatabaseSync(join(dbDir, "pipeline.db"));
    this.init();
  }

  private init(): void {
    // Migrate: add columns to existing pipeline_log tables
    const migrations = [
      "ALTER TABLE pipeline_log ADD COLUMN notify_user INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE pipeline_log ADD COLUMN is_static_scene INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE pipeline_log ADD COLUMN best_frame_index INTEGER",
      "ALTER TABLE pipeline_log ADD COLUMN vlm_model TEXT",
      "ALTER TABLE pipeline_log ADD COLUMN vlm_latency_ms INTEGER",
      "ALTER TABLE notification_log ADD COLUMN delivered INTEGER NOT NULL DEFAULT 1",
      "ALTER TABLE notification_log ADD COLUMN delivery_error TEXT",
      "ALTER TABLE notification_log ADD COLUMN delivery_ms INTEGER",
      "ALTER TABLE notification_log ADD COLUMN status TEXT NOT NULL DEFAULT 'delivered'",
      "ALTER TABLE pipeline_log ADD COLUMN segment_start INTEGER",
      "ALTER TABLE pipeline_log ADD COLUMN dialogue_json TEXT",
      "ALTER TABLE pipeline_log ADD COLUMN matched_rule_ids_json TEXT",
      "ALTER TABLE pipeline_log ADD COLUMN title TEXT",
      "ALTER TABLE traces ADD COLUMN memory_blocking_ms INTEGER",
      "ALTER TABLE subject_bindings ADD COLUMN camera_id TEXT",
    ];
    for (const sql of migrations) {
      try { this.db.exec(sql); } catch { /* column already exists */ }
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pipeline_log (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        segment_id      TEXT NOT NULL UNIQUE,
        camera_id       TEXT NOT NULL,
        mode            TEXT NOT NULL,
        event_id        TEXT,
        perception_level INTEGER NOT NULL DEFAULT 0,
        title           TEXT,
        summary         TEXT NOT NULL DEFAULT '',
        detailed_summary TEXT,
        security_risk   INTEGER NOT NULL DEFAULT 0,
        notify_user     INTEGER NOT NULL DEFAULT 0,
        is_static_scene INTEGER NOT NULL DEFAULT 0,
        best_frame_index INTEGER,
        vlm_model       TEXT,
        vlm_latency_ms  INTEGER,
        entities_json   TEXT,
        media_urls_json TEXT,
        dialogue_json   TEXT,
        matched_rule_ids_json TEXT,
        raw_url         TEXT,
        frame_count     INTEGER NOT NULL DEFAULT 0,
        duration_sec    REAL NOT NULL DEFAULT 0,
        segment_start   INTEGER,
        created_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_pipeline_camera
        ON pipeline_log(camera_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_pipeline_event
        ON pipeline_log(event_id);

      CREATE TABLE IF NOT EXISTS pipeline_errors (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        segment_id TEXT,
        camera_id  TEXT,
        stage      TEXT NOT NULL,
        error      TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS memory_write_failures (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        segment_id   TEXT NOT NULL,
        camera_id    TEXT NOT NULL,
        user_id      TEXT NOT NULL,
        attempts     INTEGER NOT NULL,
        error        TEXT NOT NULL,
        request_json TEXT NOT NULL,
        created_at   TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_memory_write_failures_camera
        ON memory_write_failures(camera_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_memory_write_failures_segment
        ON memory_write_failures(segment_id);

      CREATE TABLE IF NOT EXISTS media_files (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        segment_id TEXT NOT NULL,
        camera_id  TEXT NOT NULL,
        media_type TEXT NOT NULL,
        file_path  TEXT NOT NULL UNIQUE,
        file_size  INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_media_camera
        ON media_files(camera_id, created_at ASC);

      CREATE INDEX IF NOT EXISTS idx_media_segment
        ON media_files(segment_id);

      CREATE TABLE IF NOT EXISTS notification_log (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        segment_id     TEXT NOT NULL,
        camera_id      TEXT NOT NULL,
        type           TEXT NOT NULL,
        message        TEXT NOT NULL,
        policy         TEXT NOT NULL DEFAULT 'smart',
        path           TEXT NOT NULL DEFAULT 'unknown',
        keyframe_path  TEXT,
        status         TEXT NOT NULL DEFAULT 'delivered',
        delivered      INTEGER NOT NULL DEFAULT 1,
        delivery_error TEXT,
        delivery_ms    INTEGER,
        created_at     TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_notification_camera
        ON notification_log(camera_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_notification_segment
        ON notification_log(segment_id);

      CREATE TABLE IF NOT EXISTS traces (
        segment_id       TEXT PRIMARY KEY,
        camera_id        TEXT NOT NULL,
        created_at       INTEGER NOT NULL,
        mode             TEXT NOT NULL,
        level            INTEGER NOT NULL,
        frame_count      INTEGER NOT NULL,
        accumulation_ms  INTEGER,
        dispatch_ms      INTEGER,
        stt_ms           INTEGER,
        detection_ms     INTEGER,
        tracking_ms      INTEGER,
        reid_ms          INTEGER,
        vlm_ms           INTEGER,
        perception_ms    INTEGER NOT NULL,
        memory_blocking_ms INTEGER,
        memory_ms        INTEGER,
        e2e_ms           INTEGER NOT NULL,
        trace_json       TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_traces_camera_created
        ON traces(camera_id, created_at);

      CREATE TABLE IF NOT EXISTS llm_calls (
        call_id            TEXT PRIMARY KEY,
        run_id             TEXT,
        snapshot_version   TEXT,
        video_id           TEXT,
        camera_id          TEXT,
        segment_id         TEXT,
        stage              TEXT NOT NULL,
        provider           TEXT NOT NULL,
        model              TEXT NOT NULL,
        prompt_version     TEXT,
        prompt_tokens      INTEGER,
        completion_tokens  INTEGER,
        reasoning_tokens   INTEGER,
        total_tokens       INTEGER,
        latency_ms         INTEGER NOT NULL,
        status             TEXT NOT NULL,
        retry_count        INTEGER,
        error              TEXT,
        created_at         TEXT NOT NULL,
        call_json          TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_llm_calls_video_stage
        ON llm_calls(video_id, stage, created_at);

      CREATE INDEX IF NOT EXISTS idx_llm_calls_segment
        ON llm_calls(segment_id, created_at);

      CREATE TABLE IF NOT EXISTS subject_counters (
        user_id     TEXT NOT NULL,
        camera_id   TEXT NOT NULL DEFAULT '',
        category    TEXT NOT NULL,
        next_index  INTEGER NOT NULL,
        PRIMARY KEY (user_id, camera_id, category)
      );

      CREATE TABLE IF NOT EXISTS subject_bindings (
        user_id       TEXT NOT NULL,
        camera_id     TEXT NOT NULL DEFAULT '',
        category      TEXT NOT NULL,
        subject_index INTEGER NOT NULL,
        name          TEXT,
        entity_id     TEXT,
        wm_target_id  TEXT,
        first_seen    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        PRIMARY KEY (user_id, camera_id, category, subject_index)
      );

      CREATE INDEX IF NOT EXISTS idx_subject_bindings_entity
        ON subject_bindings(user_id, entity_id);

      CREATE INDEX IF NOT EXISTS idx_subject_bindings_wm_target
        ON subject_bindings(user_id, wm_target_id);

      CREATE INDEX IF NOT EXISTS idx_subject_bindings_camera
        ON subject_bindings(camera_id);
    `);
    this.migrateSubjectRegistrySchema();
  }

  private migrateSubjectRegistrySchema(): void {
    const tableSql = (name: string): string => {
      const row = this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(name) as { sql?: string } | undefined;
      return row?.sql ?? "";
    };
    const hasColumn = (table: string, column: string): boolean => {
      const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      return rows.some(row => row.name === column);
    };

    const bindingsSql = tableSql("subject_bindings");
    if (bindingsSql && !bindingsSql.includes("PRIMARY KEY (user_id, camera_id, category, subject_index)")) {
      const hasCameraId = hasColumn("subject_bindings", "camera_id");
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.exec(`
          DROP INDEX IF EXISTS idx_subject_bindings_entity;
          DROP INDEX IF EXISTS idx_subject_bindings_wm_target;
          DROP INDEX IF EXISTS idx_subject_bindings_camera;
          ALTER TABLE subject_bindings RENAME TO subject_bindings_old;
          CREATE TABLE subject_bindings (
            user_id       TEXT NOT NULL,
            camera_id     TEXT NOT NULL DEFAULT '',
            category      TEXT NOT NULL,
            subject_index INTEGER NOT NULL,
            name          TEXT,
            entity_id     TEXT,
            wm_target_id  TEXT,
            first_seen    INTEGER NOT NULL,
            updated_at    INTEGER NOT NULL,
            PRIMARY KEY (user_id, camera_id, category, subject_index)
          );
        `);
        this.db.exec(`
          INSERT OR IGNORE INTO subject_bindings
            (user_id, camera_id, category, subject_index, name, entity_id, wm_target_id, first_seen, updated_at)
          SELECT
            user_id,
            ${hasCameraId ? "COALESCE(camera_id, '')" : "''"},
            category,
            subject_index,
            name,
            entity_id,
            wm_target_id,
            first_seen,
            updated_at
          FROM subject_bindings_old;
          DROP TABLE subject_bindings_old;
        `);
        this.db.exec("COMMIT");
      } catch (err) {
        try { this.db.exec("ROLLBACK"); } catch { /* ignore */ }
        throw err;
      }
    }

    const countersSql = tableSql("subject_counters");
    if (countersSql && !countersSql.includes("PRIMARY KEY (user_id, camera_id, category)")) {
      const hasCameraId = hasColumn("subject_counters", "camera_id");
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.exec(`
          ALTER TABLE subject_counters RENAME TO subject_counters_old;
          CREATE TABLE subject_counters (
            user_id     TEXT NOT NULL,
            camera_id   TEXT NOT NULL DEFAULT '',
            category    TEXT NOT NULL,
            next_index  INTEGER NOT NULL,
            PRIMARY KEY (user_id, camera_id, category)
          );
        `);
        this.db.exec(`
          INSERT OR IGNORE INTO subject_counters (user_id, camera_id, category, next_index)
          SELECT user_id, ${hasCameraId ? "COALESCE(camera_id, '')" : "''"}, category, next_index
          FROM subject_counters_old;
          DROP TABLE subject_counters_old;
          INSERT INTO subject_counters (user_id, camera_id, category, next_index)
          SELECT user_id, camera_id, category, COALESCE(MAX(subject_index), 0) + 1
          FROM subject_bindings
          GROUP BY user_id, camera_id, category
          ON CONFLICT(user_id, camera_id, category) DO UPDATE SET
            next_index = max(subject_counters.next_index, excluded.next_index);
        `);
        this.db.exec("COMMIT");
      } catch (err) {
        try { this.db.exec("ROLLBACK"); } catch { /* ignore */ }
        throw err;
      }
    }

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_subject_bindings_entity
        ON subject_bindings(user_id, entity_id);
      CREATE INDEX IF NOT EXISTS idx_subject_bindings_wm_target
        ON subject_bindings(user_id, camera_id, wm_target_id);
      CREATE INDEX IF NOT EXISTS idx_subject_bindings_camera
        ON subject_bindings(camera_id);
    `);
  }

  // ════════════════════════════════════════════════════════
  // Media file storage
  // ════════════════════════════════════════════════════════

  /**
   * Save media data to local filesystem and record in SQLite.
   * Returns the absolute file path.
   *
   * Directory layout: {mediaDir}/{camera_id}/{media_type}/{segment_id}[_{suffix}].{ext}
   */
  saveMedia(
    cameraId: string,
    segmentId: string,
    mediaType: MediaType,
    data: Buffer,
    suffix?: string,
  ): string {
    const dir = join(this.mediaDir, cameraId, mediaType);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const ext = EXT_MAP[mediaType];
    const filename = suffix
      ? `${segmentId}_${suffix}.${ext}`
      : `${segmentId}.${ext}`;
    const filePath = join(dir, filename);

    writeFileSync(filePath, data);
    const fileSize = data.length;

    this.db.prepare(`
      INSERT OR REPLACE INTO media_files
        (segment_id, camera_id, media_type, file_path, file_size)
      VALUES (?, ?, ?, ?, ?)
    `).run(segmentId, cameraId, mediaType, filePath, fileSize);

    // FIFO enforcement after write
    if (this.quotaBytes > 0) {
      this.enforceQuota(cameraId);
    }

    return filePath;
  }

  /**
   * FIFO quota enforcement: delete oldest media files for a camera
   * until total size is under quota. Actually removes files from disk.
   */
  enforceQuota(cameraId: string): string[] {
    const totalSize = (this.db.prepare(`
      SELECT COALESCE(SUM(file_size), 0) as total
      FROM media_files WHERE camera_id = ?
    `).get(cameraId) as { total: number }).total;

    if (totalSize <= this.quotaBytes) return [];

    // Get oldest files first
    const oldest = this.db.prepare(`
      SELECT id, segment_id, file_path, file_size
      FROM media_files
      WHERE camera_id = ?
      ORDER BY created_at ASC
    `).all(cameraId) as Array<{ id: number; segment_id: string; file_path: string; file_size: number }>;

    let currentSize = totalSize;
    const deletedSegments: string[] = [];
    const deleteIds: number[] = [];

    for (const row of oldest) {
      if (currentSize <= this.quotaBytes) break;
      currentSize -= row.file_size;
      deleteIds.push(row.id);
      if (!deletedSegments.includes(row.segment_id)) {
        deletedSegments.push(row.segment_id);
      }

      // Delete actual file from disk
      try {
        if (existsSync(row.file_path)) unlinkSync(row.file_path);
      } catch {
        // Best-effort file deletion
      }
    }

    if (deleteIds.length > 0) {
      const placeholders = deleteIds.map(() => "?").join(",");
      this.db.prepare(
        `DELETE FROM media_files WHERE id IN (${placeholders})`,
      ).run(...deleteIds);
    }

    return deletedSegments;
  }

  /** Get all media file paths for a segment. */
  getMediaForSegment(segmentId: string): MediaFileEntry[] {
    return this.db.prepare(`
      SELECT * FROM media_files WHERE segment_id = ? ORDER BY media_type
    `).all(segmentId) as unknown as MediaFileEntry[];
  }

  /** Build MediaUrls from stored media files for a segment. */
  buildMediaUrls(segmentId: string): MediaUrls {
    const files = this.getMediaForSegment(segmentId);
    const raw = files.find((f) => f.media_type === "raw")?.file_path ?? "";
    const gif = files.find((f) => f.media_type === "gif")?.file_path;
    const keyframes = files
      .filter((f) => f.media_type === "keyframe")
      .map((f) => f.file_path);
    const crops = files
      .filter((f) => f.media_type === "crop")
      .map((f) => f.file_path);
    return { raw, gif, keyframes, crops };
  }

  /** Get total media size in bytes for a camera. */
  getMediaSize(cameraId: string): number {
    return (this.db.prepare(`
      SELECT COALESCE(SUM(file_size), 0) as total
      FROM media_files WHERE camera_id = ?
    `).get(cameraId) as { total: number }).total;
  }

  /** Get media stats per camera. */
  getMediaStats(): Array<{ camera_id: string; file_count: number; total_size: number }> {
    return this.db.prepare(`
      SELECT camera_id, COUNT(*) as file_count, SUM(file_size) as total_size
      FROM media_files GROUP BY camera_id
    `).all() as any[];
  }

  // ════════════════════════════════════════════════════════
  // Subject index registry
  // ════════════════════════════════════════════════════════

  createSubjectIndexSession(userId: string, cameraId?: string): SubjectIndexSession {
    const normalizedUserId = userId.trim() || "admin";
    const normalizedCameraId = typeof cameraId === "string" && cameraId.trim()
      ? cameraId.trim()
      : undefined;
    const cameraScope = normalizedCameraId ?? "";
    const byEntity = new Map<string, SubjectIndexIdentity>();
    const entityMeta = new Map<string, Pick<SubjectIndexIdentity, "name" | "first_seen">>();
    const byWmTarget = new Map<string, SubjectIndexIdentity>();
    const byIndex = new Map<string, SubjectIndexIdentity>();
    const dirty = new Map<string, SubjectIndexIdentity>();
    const clearedWmAliases: Array<{
      user_id: string;
      camera_id: string;
      category: string;
      subject_index: number;
      wm_target_id: string;
    }> = [];
    const deletedBindings: Array<{
      user_id: string;
      camera_id: string;
      category: string;
      subject_index: number;
    }> = [];

    const normalizeCategory = (value: string): string => {
      const raw = value.trim().toLowerCase();
      if (!raw) return "object";
      if (raw === "human" || raw === "person") return "person";
      if (raw === "vehicle" || raw === "car") return "car";
      if (raw === "animal" || raw === "pet" || raw === "dog" || raw === "cat") return raw === "cat" ? "cat" : raw === "dog" ? "dog" : "animal";
      return raw.replace(/[^a-z0-9_-]+/g, "_") || "object";
    };
    const identityKey = (cameraId: string | undefined, category: string, index: number): string => `${cameraId ?? ""}:${category}:${index}`;
    const entityKey = (entityId: string, cameraId?: string): string => `${cameraId ?? ""}\u0000${entityId}`;
    const wmKey = (targetId: string, cameraId?: string): string => `${cameraId ?? ""}\u0000${targetId}`;
    const clone = (identity: SubjectIndexIdentity): SubjectIndexIdentity => ({ ...identity });
    const remember = (identity: SubjectIndexIdentity): SubjectIndexIdentity => {
      const stored = clone(identity);
      if (stored.entity_id) {
        const existing = byEntity.get(entityKey(stored.entity_id, stored.camera_id));
        if (existing && existing.category === stored.category && existing.subject_index !== stored.subject_index) {
          existing.name = existing.name ?? stored.name;
          if (stored.wm_target_id && (!existing.wm_target_id || stored.updated_at >= existing.updated_at)) {
            existing.wm_target_id = stored.wm_target_id;
          }
          existing.first_seen = Math.min(existing.first_seen, stored.first_seen);
          existing.updated_at = Math.max(existing.updated_at, stored.updated_at);
          if (stored.wm_target_id) byWmTarget.set(wmKey(stored.wm_target_id, stored.camera_id), existing);
          byIndex.delete(identityKey(stored.camera_id, stored.category, stored.subject_index));
          deletedBindings.push({
            user_id: stored.user_id,
            camera_id: stored.camera_id ?? "",
            category: stored.category,
            subject_index: stored.subject_index,
          });
          dirty.set(identityKey(existing.camera_id, existing.category, existing.subject_index), clone(existing));
          return existing;
        }
      }
      byIndex.set(identityKey(stored.camera_id, stored.category, stored.subject_index), stored);
      if (stored.entity_id) {
        byEntity.set(entityKey(stored.entity_id, stored.camera_id), stored);
        const current = entityMeta.get(stored.entity_id);
        entityMeta.set(stored.entity_id, {
          name: stored.name ?? current?.name,
          first_seen: Math.min(current?.first_seen ?? stored.first_seen, stored.first_seen),
        });
      }
      if (stored.wm_target_id) byWmTarget.set(wmKey(stored.wm_target_id, stored.camera_id), stored);
      return stored;
    };
    const unbindWmAlias = (targetId: string, identity: SubjectIndexIdentity): void => {
      for (const key of [wmKey(targetId, identity.camera_id), wmKey(targetId)]) {
        const current = byWmTarget.get(key);
        if (current && current.category === identity.category && current.subject_index === identity.subject_index && current.camera_id === identity.camera_id) {
          byWmTarget.delete(key);
        }
      }
      if (identity.wm_target_id === targetId) {
        delete identity.wm_target_id;
      }
    };

    const nextIndexForCategory = (category: string): number => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const counterRow = this.db.prepare(`
            SELECT next_index FROM subject_counters WHERE user_id = ? AND camera_id = ? AND category = ?
          `).get(normalizedUserId, cameraScope, category) as { next_index?: number } | undefined;
        let nextIndex = Math.max(1, counterRow?.next_index ?? 0);
        if (!counterRow) {
          const bindingRow = this.db.prepare(`
              SELECT COALESCE(MAX(subject_index), 0) + 1 AS next_index
              FROM subject_bindings WHERE user_id = ? AND camera_id = ? AND category = ?
            `).get(normalizedUserId, cameraScope, category) as { next_index?: number } | undefined;
          nextIndex = Math.max(1, bindingRow?.next_index ?? 1);
          this.db.prepare(`
              INSERT INTO subject_counters (user_id, camera_id, category, next_index)
              VALUES (?, ?, ?, ?)
            `).run(normalizedUserId, cameraScope, category, nextIndex + 1);
        } else {
          this.db.prepare(`
              UPDATE subject_counters SET next_index = ? WHERE user_id = ? AND camera_id = ? AND category = ?
            `).run(nextIndex + 1, normalizedUserId, cameraScope, category);
        }
        this.db.exec("COMMIT");
        return nextIndex;
      } catch (err) {
        try { this.db.exec("ROLLBACK"); } catch { /* ignore */ }
        throw err;
      }
    };

    const bindingRows = this.db.prepare(`
      SELECT user_id, camera_id, category, subject_index, name, entity_id, wm_target_id, first_seen, updated_at
      FROM subject_bindings WHERE user_id = ?
      ORDER BY COALESCE(camera_id, ''), category, subject_index
    `).all(normalizedUserId) as Array<{
      user_id: string;
      camera_id: string | null;
      category: string;
      subject_index: number;
      name: string | null;
      entity_id: string | null;
      wm_target_id: string | null;
      first_seen: number;
      updated_at: number;
    }>;
    for (const row of bindingRows) {
      remember({
        user_id: row.user_id,
        camera_id: row.camera_id ?? "",
        category: row.category,
        subject_index: row.subject_index,
        ...(row.name ? { name: row.name } : {}),
        ...(row.entity_id ? { entity_id: row.entity_id } : {}),
        ...(row.wm_target_id ? { wm_target_id: row.wm_target_id } : {}),
        first_seen: row.first_seen,
        updated_at: row.updated_at,
      });
    }

    const allocate = (category: string, now: number): SubjectIndexIdentity => {
      const nextIndex = nextIndexForCategory(category);
      return remember({
        user_id: normalizedUserId,
        ...(normalizedCameraId ? { camera_id: normalizedCameraId } : {}),
        category,
        subject_index: nextIndex,
        first_seen: now,
        updated_at: now,
      });
    };
    const adoptLegacyGlobalIdentity = (identity: SubjectIndexIdentity, now: number): SubjectIndexIdentity => {
      if (!normalizedCameraId || identity.camera_id) return identity;
      const scopedIndexKey = identityKey(normalizedCameraId, identity.category, identity.subject_index);
      const existingAtIndex = byIndex.get(scopedIndexKey);
      if (existingAtIndex && existingAtIndex !== identity) {
        const scoped = allocate(identity.category, Math.min(identity.first_seen, now));
        scoped.name = scoped.name ?? identity.name;
        scoped.entity_id = scoped.entity_id ?? identity.entity_id;
        scoped.wm_target_id = scoped.wm_target_id ?? identity.wm_target_id;
        scoped.first_seen = Math.min(scoped.first_seen, identity.first_seen);
        scoped.updated_at = Math.max(scoped.updated_at, now, identity.updated_at);
        return remember(scoped);
      }
      identity.camera_id = normalizedCameraId;
      identity.updated_at = Math.max(identity.updated_at, now);
      return remember(identity);
    };

    return {
      resolve: (input) => {
        const category = normalizeCategory(input.category);
        const now = input.timestamp && Number.isFinite(input.timestamp) ? Math.round(input.timestamp) : Date.now();
        const name = input.name?.trim();
        // Stable ReID identity is the primary subject handle. WM targets are
        // event-local aliases and must not relabel an existing entity.
        let identity = input.entity_id
          ? byEntity.get(entityKey(input.entity_id, normalizedCameraId))
          : undefined;
        if (!identity && input.wm_target_id) {
          identity = byWmTarget.get(wmKey(input.wm_target_id, normalizedCameraId))
            ?? byWmTarget.get(wmKey(input.wm_target_id));
        }
        if (!identity && typeof input.subject_index === "number" && Number.isFinite(input.subject_index) && input.subject_index > 0) {
          const indexed = byIndex.get(identityKey(normalizedCameraId, category, Math.floor(input.subject_index)));
          if (!input.entity_id || !indexed || (!indexed.entity_id && !indexed.wm_target_id)) {
            identity = indexed;
          }
        }
        if (!identity) identity = allocate(category, now);
        identity = adoptLegacyGlobalIdentity(identity, now);

        let changed = false;
        if (input.entity_id && identity.entity_id !== input.entity_id) {
          identity.entity_id = input.entity_id;
          byEntity.set(entityKey(input.entity_id, normalizedCameraId), identity);
          changed = true;
        }
        if (input.entity_id && !identity.name) {
          const meta = entityMeta.get(input.entity_id);
          if (meta?.name) {
            identity.name = meta.name;
            changed = true;
          }
        }
        if (input.wm_target_id) {
          const currentAlias = byWmTarget.get(wmKey(input.wm_target_id, normalizedCameraId))
            ?? byWmTarget.get(wmKey(input.wm_target_id));
          if (currentAlias && currentAlias !== identity) {
            clearedWmAliases.push({
              user_id: currentAlias.user_id,
              camera_id: currentAlias.camera_id ?? "",
              category: currentAlias.category,
              subject_index: currentAlias.subject_index,
              wm_target_id: input.wm_target_id,
            });
            unbindWmAlias(input.wm_target_id, currentAlias);
            if (!currentAlias.entity_id && !currentAlias.name) {
              deletedBindings.push({
                user_id: currentAlias.user_id,
                camera_id: currentAlias.camera_id ?? "",
                category: currentAlias.category,
                subject_index: currentAlias.subject_index,
              });
              byIndex.delete(identityKey(currentAlias.camera_id, currentAlias.category, currentAlias.subject_index));
            } else {
              dirty.set(identityKey(currentAlias.camera_id, currentAlias.category, currentAlias.subject_index), clone(currentAlias));
            }
          }
          const canPersistWmAlias = !identity.camera_id || !normalizedCameraId || identity.camera_id === normalizedCameraId;
          byWmTarget.set(wmKey(input.wm_target_id, normalizedCameraId), identity);
          if (canPersistWmAlias && identity.wm_target_id !== input.wm_target_id) {
            if (normalizedCameraId && !identity.camera_id) identity.camera_id = normalizedCameraId;
            identity.wm_target_id = input.wm_target_id;
            changed = true;
          }
        }
        if (name && identity.name !== name) {
          identity.name = name;
          changed = true;
        }
        if (input.entity_id && identity.name) {
          entityMeta.set(input.entity_id, {
            name: identity.name,
            first_seen: entityMeta.get(input.entity_id)?.first_seen ?? identity.first_seen,
          });
        }
        if (changed) identity.updated_at = now;
        dirty.set(identityKey(identity.camera_id, identity.category, identity.subject_index), clone(identity));
        return clone(identity);
      },
      commit: () => {
        const entries = Array.from(dirty.values());
        if (!entries.length && !clearedWmAliases.length && !deletedBindings.length) return;
        this.db.exec("BEGIN IMMEDIATE");
        try {
          const upsertBinding = this.db.prepare(`
            INSERT INTO subject_bindings
              (user_id, camera_id, category, subject_index, name, entity_id, wm_target_id, first_seen, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id, camera_id, category, subject_index) DO UPDATE SET
              name = COALESCE(excluded.name, subject_bindings.name),
              entity_id = COALESCE(excluded.entity_id, subject_bindings.entity_id),
              wm_target_id = COALESCE(excluded.wm_target_id, subject_bindings.wm_target_id),
              first_seen = min(subject_bindings.first_seen, excluded.first_seen),
              updated_at = max(subject_bindings.updated_at, excluded.updated_at)
          `);
          const deleteLegacyGlobalBinding = this.db.prepare(`
            DELETE FROM subject_bindings
            WHERE user_id = ?
              AND camera_id = ''
              AND category = ?
              AND (
                (? IS NOT NULL AND entity_id = ?)
                OR (? IS NOT NULL AND wm_target_id = ?)
              )
          `);
          const clearWmAlias = this.db.prepare(`
            UPDATE subject_bindings
            SET wm_target_id = NULL
            WHERE user_id = ?
              AND camera_id = ?
              AND category = ?
              AND subject_index = ?
              AND wm_target_id = ?
          `);
          const deleteBinding = this.db.prepare(`
            DELETE FROM subject_bindings
            WHERE user_id = ?
              AND camera_id = ?
              AND category = ?
              AND subject_index = ?
          `);
          for (const deleted of deletedBindings) {
            deleteBinding.run(
              deleted.user_id,
              deleted.camera_id,
              deleted.category,
              deleted.subject_index,
            );
          }
          for (const cleared of clearedWmAliases) {
            clearWmAlias.run(
              cleared.user_id,
              cleared.camera_id,
              cleared.category,
              cleared.subject_index,
              cleared.wm_target_id,
            );
          }
          for (const entry of entries) {
            if (entry.camera_id) {
              deleteLegacyGlobalBinding.run(
                entry.user_id,
                entry.category,
                entry.entity_id ?? null,
                entry.entity_id ?? null,
                entry.wm_target_id ?? null,
                entry.wm_target_id ?? null,
              );
            }
            upsertBinding.run(
              entry.user_id,
              entry.camera_id ?? "",
              entry.category,
              entry.subject_index,
              entry.name ?? null,
              entry.entity_id ?? null,
              entry.wm_target_id ?? null,
              entry.first_seen,
              entry.updated_at,
            );
          }
          this.db.exec("COMMIT");
        } catch (err) {
          try { this.db.exec("ROLLBACK"); } catch { /* ignore */ }
          throw err;
        }
      },
    };
  }

  // ════════════════════════════════════════════════════════
  // Pipeline log (unchanged)
  // ════════════════════════════════════════════════════════

  /** Extra VLM fields to log alongside the perception result. */
  logResult(segment: Segment, result: PerceptionResult, vlmExtra?: {
    notify_user?: boolean;
    is_static_scene?: boolean;
    best_frame_index?: number;
    vlm_model?: string;
    vlm_latency_ms?: number;
  }): void {
    const pm = result.perception_memory;
    this.db.prepare(`
      INSERT OR REPLACE INTO pipeline_log
        (segment_id, camera_id, mode, event_id,
         perception_level, title, summary, detailed_summary,
         security_risk, notify_user, is_static_scene,
         best_frame_index, vlm_model, vlm_latency_ms,
         entities_json, media_urls_json, dialogue_json, matched_rule_ids_json,
         raw_url, frame_count, duration_sec, segment_start)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      result.segment_id,
      result.camera_id,
      result.mode,
      result.event_id ?? null,
      pm.perception_level,
      pm.title ?? null,
      pm.summary,
      pm.detailed_summary ?? null,
      pm.security_risk ? 1 : 0,
      vlmExtra?.notify_user ? 1 : 0,
      vlmExtra?.is_static_scene ? 1 : 0,
      vlmExtra?.best_frame_index ?? null,
      vlmExtra?.vlm_model ?? null,
      vlmExtra?.vlm_latency_ms ?? null,
      pm.entities ? JSON.stringify(pm.entities) : null,
      result.media_urls ? JSON.stringify(result.media_urls) : null,
      this.buildDialogueJson(result),
      result.perception_memory.matched_rule_ids?.length ? JSON.stringify(result.perception_memory.matched_rule_ids) : null,
      segment.raw_url || null,
      segment.frames.length,
      segment.duration_sec,
      segment.timestamp,
    );
  }

  private buildDialogueJson(result: PerceptionResult): string | null {
    if (!result.transcript && !result.dialogue?.length) {
      return null;
    }
    return JSON.stringify({
      ...(result.transcript ? { transcript: result.transcript } : {}),
      ...(result.dialogue?.length ? { dialogue: result.dialogue } : {}),
    });
  }

  /** Log a sent notification with delivery tracking. */
  logNotification(entry: {
    segment_id: string;
    camera_id: string;
    type: string;
    message: string;
    policy: string;
    path: string;
    keyframe_path?: string;
    status?: "delivery_pending" | "delivered" | "failed";
    delivered?: boolean;
    delivery_error?: string;
    delivery_ms?: number;
  }): number {
    const status = entry.status ?? (entry.delivered === false ? "failed" : "delivered");
    const delivered = status === "delivered" ? 1 : 0;
    const result = this.db.prepare(`
      INSERT INTO notification_log
        (segment_id, camera_id, type, message, policy, path, keyframe_path,
         status, delivered, delivery_error, delivery_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.segment_id,
      entry.camera_id,
      entry.type,
      entry.message,
      entry.policy,
      entry.path,
      entry.keyframe_path ?? null,
      status,
      delivered,
      entry.delivery_error ?? null,
      entry.delivery_ms ?? null,
    );
    return Number(result.lastInsertRowid);
  }

  /** Update an existing notification row with the terminal delivery result. */
  updateNotificationDelivery(
    id: number,
    delivery: { delivered: boolean; delivery_error?: string; delivery_ms?: number },
  ): void {
    this.db.prepare(`
      UPDATE notification_log
      SET status = ?, delivered = ?, delivery_error = ?, delivery_ms = ?
      WHERE id = ?
    `).run(
      delivery.delivered ? "delivered" : "failed",
      delivery.delivered ? 1 : 0,
      delivery.delivery_error ?? null,
      delivery.delivery_ms ?? null,
      id,
    );
  }

  /** Query recent notifications for a camera. */
  getRecentNotifications(cameraId?: string, limit = 50): Array<{
    segment_id: string; camera_id: string; type: string;
    message: string; policy: string; path: string;
    status: string;
    keyframe_path: string | null; delivered: number;
    delivery_error: string | null; delivery_ms: number | null;
    created_at: string;
  }> {
    if (cameraId) {
      return this.db.prepare(`
        SELECT * FROM notification_log WHERE camera_id = ? ORDER BY created_at DESC LIMIT ?
      `).all(cameraId, limit) as any[];
    }
    return this.db.prepare(`
      SELECT * FROM notification_log ORDER BY created_at DESC LIMIT ?
    `).all(limit) as any[];
  }

  /** Query notification messages for one segment, oldest-first for stable hydration. */
  getNotificationMessages(segmentId: string): string[] {
    const rows = this.db.prepare(`
      SELECT message FROM notification_log
      WHERE segment_id = ?
      ORDER BY created_at ASC, id ASC
    `).all(segmentId) as Array<{ message: string }>;
    return rows.map((row) => row.message);
  }

  /** Log a pipeline error. */
  logError(segmentId: string | null, cameraId: string | null, stage: string, error: string): void {
    this.db.prepare(`
      INSERT INTO pipeline_errors (segment_id, camera_id, stage, error)
      VALUES (?, ?, ?, ?)
    `).run(segmentId, cameraId, stage, error);
  }

  /** Record the final failed memory write payload for diagnosis/replay. */
  logMemoryWriteFailure(input: {
    segment_id: string;
    camera_id: string;
    user_id: string;
    attempts: number;
    error: string;
    request: unknown;
  }): number {
    const result = this.db.prepare(`
      INSERT INTO memory_write_failures (
        segment_id, camera_id, user_id, attempts, error, request_json
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      input.segment_id,
      input.camera_id,
      input.user_id,
      input.attempts,
      input.error,
      JSON.stringify(input.request),
    );
    return Number(result.lastInsertRowid);
  }

  /**
   * Apply local retention without touching persistent semantic/ReID memory.
   *
   * Generated media expires first: local files are removed and row references
   * are nulled so Dashboard can keep text-only cards. Text/log rows expire on a
   * longer horizon and delete dependent diagnostics by segment_id.
   */
  runRetention(options: PipelineRetentionOptions = {}): PipelineRetentionResult {
    const mediaRetentionDays = normalizeRetentionDays(
      options.mediaRetentionDays,
      DEFAULT_MEDIA_RETENTION_DAYS,
    );
    const textRetentionDays = normalizeRetentionDays(
      options.textRetentionDays,
      DEFAULT_TEXT_RETENTION_DAYS,
    );
    const nowMs = Number.isFinite(options.nowMs) ? options.nowMs! : Date.now();
    const result: PipelineRetentionResult = {
      mediaRetentionDays,
      textRetentionDays,
      mediaCutoffMs: mediaRetentionDays > 0 ? nowMs - mediaRetentionDays * DAY_MS : null,
      textCutoffMs: textRetentionDays > 0 ? nowMs - textRetentionDays * DAY_MS : null,
      mediaFilesDeleted: 0,
      mediaReferencesExpired: 0,
      mediaSegmentsExpired: [],
      pipelineRowsDeleted: 0,
      notificationRowsDeleted: 0,
      errorRowsDeleted: 0,
      traceRowsDeleted: 0,
      llmCallRowsDeleted: 0,
      memoryWriteFailureRowsDeleted: 0,
    };

    const expiredSegmentKeys = new Set<string>();
    const rememberExpiredSegments = (segments: PipelineRetentionExpiredSegment[]) => {
      for (const segment of segments) {
        const key = `${segment.camera_id}\u0000${segment.segment_id}`;
        if (expiredSegmentKeys.has(key)) continue;
        expiredSegmentKeys.add(key);
        result.mediaSegmentsExpired.push(segment);
      }
    };

    if (result.mediaCutoffMs !== null) {
      rememberExpiredSegments(this.expireMediaOlderThan(result.mediaCutoffMs, result));
    }
    if (result.textCutoffMs !== null) {
      rememberExpiredSegments(this.deleteTextRowsOlderThan(result.textCutoffMs, result));
    }
    return result;
  }

  private expireMediaOlderThan(
    cutoffMs: number,
    result: PipelineRetentionResult,
  ): PipelineRetentionExpiredSegment[] {
    const cutoffSec = Math.floor(cutoffMs / 1000);
    const mediaRows = this.db.prepare(`
      SELECT mf.id, mf.segment_id, mf.camera_id, mf.file_path
      FROM media_files mf
      LEFT JOIN pipeline_log pl ON pl.segment_id = mf.segment_id
      WHERE COALESCE(unixepoch(pl.created_at), unixepoch(mf.created_at), 0) < ?
    `).all(cutoffSec) as Array<{ id: number; segment_id: string; camera_id: string; file_path: string }>;
    result.mediaFilesDeleted += this.deleteMediaRows(mediaRows);

    const segmentCandidates = this.db.prepare(`
      SELECT segment_id, camera_id, media_urls_json, raw_url
      FROM pipeline_log
      WHERE unixepoch(created_at) < ?
        AND (media_urls_json IS NOT NULL OR raw_url IS NOT NULL)
    `).all(cutoffSec) as unknown as Array<PipelineRetentionExpiredSegment & {
      media_urls_json: string | null;
      raw_url: string | null;
    }>;
    const segments = segmentCandidates
      .filter(hasMediaReference)
      .map(({ segment_id, camera_id }) => ({ segment_id, camera_id }));
    if (segments.length > 0) {
      result.mediaReferencesExpired += this.updateSegmentsById(segments.map((row) => row.segment_id), `
        UPDATE pipeline_log
        SET media_urls_json = NULL, raw_url = NULL
        WHERE segment_id IN (__IDS__)
      `);
    }
    return uniqueRetentionSegments([...segments, ...mediaRows]);
  }

  private deleteTextRowsOlderThan(
    cutoffMs: number,
    result: PipelineRetentionResult,
  ): PipelineRetentionExpiredSegment[] {
    const cutoffSec = Math.floor(cutoffMs / 1000);
    const oldSegmentRows = this.db.prepare(`
      SELECT segment_id, camera_id, media_urls_json, raw_url
      FROM pipeline_log
      WHERE unixepoch(created_at) < ?
    `).all(cutoffSec) as unknown as Array<PipelineRetentionExpiredSegment & {
      media_urls_json: string | null;
      raw_url: string | null;
    }>;
    const oldSegments = oldSegmentRows.map(({ segment_id, camera_id }) => ({ segment_id, camera_id }));
    const segmentIds = oldSegments.map((row) => row.segment_id);
    let expiredMediaSegments: PipelineRetentionExpiredSegment[] = oldSegmentRows
      .filter(hasMediaReference)
      .map(({ segment_id, camera_id }) => ({ segment_id, camera_id }));

    if (segmentIds.length > 0) {
      const mediaRows = this.selectMediaRowsBySegmentIds(segmentIds);
      expiredMediaSegments = uniqueRetentionSegments([...expiredMediaSegments, ...mediaRows]);
      result.mediaFilesDeleted += this.deleteMediaRows(mediaRows);
      result.notificationRowsDeleted += this.deleteRowsBySegmentIds("notification_log", segmentIds);
      result.errorRowsDeleted += this.deleteRowsBySegmentIds("pipeline_errors", segmentIds);
      result.traceRowsDeleted += this.deleteRowsBySegmentIds("traces", segmentIds);
      result.llmCallRowsDeleted += this.deleteRowsBySegmentIds("llm_calls", segmentIds);
      result.memoryWriteFailureRowsDeleted += this.deleteRowsBySegmentIds("memory_write_failures", segmentIds);
      result.pipelineRowsDeleted += this.deleteRowsBySegmentIds("pipeline_log", segmentIds);
    }

    result.notificationRowsDeleted += this.deleteRowsOlderThan("notification_log", cutoffSec);
    result.errorRowsDeleted += this.deleteRowsOlderThan("pipeline_errors", cutoffSec);
    result.traceRowsDeleted += this.deleteTraceRowsOlderThan(cutoffMs);
    result.llmCallRowsDeleted += this.deleteRowsOlderThan("llm_calls", cutoffSec);
    result.memoryWriteFailureRowsDeleted += this.deleteRowsOlderThan("memory_write_failures", cutoffSec);
    return expiredMediaSegments;
  }

  private selectMediaRowsBySegmentIds(segmentIds: string[]): Array<{ id: number; segment_id: string; camera_id: string; file_path: string }> {
    const rows: Array<{ id: number; segment_id: string; camera_id: string; file_path: string }> = [];
    this.forEachChunk(segmentIds, (chunk, placeholders) => {
      rows.push(...this.db.prepare(`
        SELECT id, segment_id, camera_id, file_path
        FROM media_files
        WHERE segment_id IN (${placeholders})
      `).all(...chunk) as Array<{ id: number; segment_id: string; camera_id: string; file_path: string }>);
    });
    return rows;
  }

  private deleteMediaRows(rows: Array<{ id: number; file_path: string }>): number {
    if (rows.length === 0) return 0;
    for (const row of rows) {
      try {
        if (existsSync(row.file_path)) unlinkSync(row.file_path);
      } catch {
        // Best-effort file deletion only; DB retention must still progress.
      }
    }
    let deleted = 0;
    this.forEachChunk(rows.map((row) => row.id), (chunk, placeholders) => {
      deleted += Number(this.db.prepare(`DELETE FROM media_files WHERE id IN (${placeholders})`).run(...chunk).changes ?? 0);
    });
    return deleted;
  }

  private deleteRowsBySegmentIds(table: string, segmentIds: string[]): number {
    let deleted = 0;
    this.forEachChunk(segmentIds, (chunk, placeholders) => {
      deleted += Number(this.db.prepare(`DELETE FROM ${table} WHERE segment_id IN (${placeholders})`).run(...chunk).changes ?? 0);
    });
    return deleted;
  }

  private updateSegmentsById(segmentIds: string[], sqlTemplate: string): number {
    let updated = 0;
    this.forEachChunk(segmentIds, (chunk, placeholders) => {
      updated += Number(this.db.prepare(sqlTemplate.replace("__IDS__", placeholders)).run(...chunk).changes ?? 0);
    });
    return updated;
  }

  private deleteRowsOlderThan(table: string, cutoffSec: number): number {
    return Number(this.db.prepare(`
      DELETE FROM ${table}
      WHERE COALESCE(unixepoch(created_at), 0) < ?
    `).run(cutoffSec).changes ?? 0);
  }

  private deleteTraceRowsOlderThan(cutoffMs: number): number {
    return Number(this.db.prepare(`
      DELETE FROM traces WHERE created_at < ?
    `).run(cutoffMs).changes ?? 0);
  }

  private forEachChunk<T>(values: T[], fn: (chunk: T[], placeholders: string) => void): void {
    const size = 500;
    for (let i = 0; i < values.length; i += size) {
      const chunk = values.slice(i, i + size);
      if (chunk.length === 0) continue;
      fn(chunk, chunk.map(() => "?").join(","));
    }
  }

  /** Query recent terminal memory write failures. */
  getRecentMemoryWriteFailures(cameraId?: string, limit = 50): MemoryWriteFailureEntry[] {
    if (cameraId) {
      return this.db.prepare(`
        SELECT * FROM memory_write_failures
        WHERE camera_id = ?
        ORDER BY created_at DESC LIMIT ?
      `).all(cameraId, limit) as unknown as MemoryWriteFailureEntry[];
    }
    return this.db.prepare(`
      SELECT * FROM memory_write_failures
      ORDER BY created_at DESC LIMIT ?
    `).all(limit) as unknown as MemoryWriteFailureEntry[];
  }

  /** Query recent perception results for a camera. */
  getRecent(cameraId?: string, limit = 20): PipelineLogEntry[] {
    if (cameraId) {
      return this.db.prepare(`
        SELECT * FROM pipeline_log
        WHERE camera_id = ?
        ORDER BY created_at DESC LIMIT ?
      `).all(cameraId, limit) as unknown as PipelineLogEntry[];
    }
    return this.db.prepare(`
      SELECT * FROM pipeline_log
      ORDER BY created_at DESC LIMIT ?
    `).all(limit) as unknown as PipelineLogEntry[];
  }

  /** Look up a single pipeline log entry by segment_id. Returns null when not found. */
  getBySegmentId(segmentId: string): PipelineLogEntry | null {
    const row = this.db.prepare(`
      SELECT * FROM pipeline_log WHERE segment_id = ?
    `).get(segmentId) as PipelineLogEntry | undefined;
    return row ?? null;
  }

  /** Search perception results by keyword in summary. */
  search(query: string, limit = 20): PipelineLogEntry[] {
    const pattern = `%${query}%`;
    return this.db.prepare(`
      SELECT * FROM pipeline_log
      WHERE summary LIKE ? OR detailed_summary LIKE ?
      ORDER BY created_at DESC LIMIT ?
    `).all(pattern, pattern, limit) as unknown as PipelineLogEntry[];
  }

  /** Get all results for a specific event_id. */
  getByEvent(eventId: string): PipelineLogEntry[] {
    return this.db.prepare(`
      SELECT * FROM pipeline_log
      WHERE event_id = ?
      ORDER BY created_at ASC
    `).all(eventId) as unknown as PipelineLogEntry[];
  }

  /** Get recent errors. */
  getErrors(limit = 50): Array<{ id: number; segment_id: string | null; camera_id: string | null; stage: string; error: string; created_at: string }> {
    return this.db.prepare(`
      SELECT * FROM pipeline_errors
      ORDER BY created_at DESC LIMIT ?
    `).all(limit) as any[];
  }

  /** Get total segment count for a camera (used by SemanticContextManager trigger logic). */
  getSegmentCount(cameraId: string): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) as count FROM pipeline_log WHERE camera_id = ?`,
    ).get(cameraId) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  /** Get stats per camera. */
  getStats(): Array<{ camera_id: string; total: number; security_alerts: number; last_seen: string }> {
    return this.db.prepare(`
      SELECT camera_id,
             COUNT(*) as total,
             SUM(security_risk) as security_alerts,
             MAX(created_at) as last_seen
      FROM pipeline_log
      GROUP BY camera_id
    `).all() as any[];
  }

  // ════════════════════════════════════════════════════════
  // Pipeline traces (profiling)
  // ════════════════════════════════════════════════════════

  saveTrace(trace: PipelineTrace): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO traces (segment_id, camera_id, created_at, mode, level,
        frame_count, accumulation_ms, dispatch_ms, stt_ms, detection_ms, tracking_ms,
        reid_ms, vlm_ms, perception_ms, memory_blocking_ms, memory_ms, e2e_ms, trace_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      trace.segment_id,
      trace.camera_id,
      trace.timestamps.analysis_started_at,
      trace.context.mode,
      trace.context.level,
      trace.context.frame_count,
      trace.latencies.accumulation_ms ?? null,
      trace.latencies.dispatch_ms ?? null,
      trace.latencies.stt_ms ?? null,
      trace.latencies.detection_ms ?? null,
      trace.latencies.tracking_ms ?? null,
      trace.latencies.reid_ms ?? null,
      trace.latencies.vlm_ms ?? null,
      trace.latencies.perception_ms,
      trace.latencies.memory_blocking_ms ?? null,
      trace.latencies.memory_ms ?? null,
      trace.latencies.e2e_ms,
      JSON.stringify(trace),
    );

    if (Date.now() - this.lastTraceCleanupAt > this.cleanupIntervalMs) {
      this.cleanupTraces();
      this.lastTraceCleanupAt = Date.now();
    }
  }

  private cleanupTraces(): void {
    this.db.prepare(`
      DELETE FROM traces WHERE segment_id NOT IN (
        SELECT segment_id FROM traces ORDER BY created_at DESC LIMIT ?
      )
    `).run(this.traceKeepCount);
  }

  saveLlmCall(call: LlmCallRecord): void {
    const usage = call.usage ?? {};
    this.db.prepare(`
      INSERT OR REPLACE INTO llm_calls (
        call_id, run_id, snapshot_version, video_id, camera_id, segment_id,
        stage, provider, model, prompt_version,
        prompt_tokens, completion_tokens, reasoning_tokens, total_tokens,
        latency_ms, status, retry_count, error, created_at, call_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      call.call_id,
      call.run_id ?? null,
      call.snapshot_version ?? null,
      call.video_id ?? null,
      call.camera_id ?? null,
      call.segment_id ?? null,
      call.stage,
      call.provider,
      call.model,
      call.prompt_version ?? null,
      usage.prompt_tokens ?? null,
      usage.completion_tokens ?? null,
      usage.reasoning_tokens ?? null,
      usage.total_tokens ?? null,
      Math.round(call.latency_ms),
      call.status,
      call.retry_count ?? null,
      call.error ?? null,
      call.created_at,
      JSON.stringify(call),
    );
  }

  getRecentTraces(cameraId?: string, limit = 50): PipelineTrace[] {
    const rows = cameraId
      ? this.db.prepare(`SELECT trace_json FROM traces WHERE camera_id = ? ORDER BY created_at DESC LIMIT ?`).all(cameraId, limit)
      : this.db.prepare(`SELECT trace_json FROM traces ORDER BY created_at DESC LIMIT ?`).all(limit);
    return (rows as Array<{ trace_json: string }>).map(r => JSON.parse(r.trace_json));
  }

  getTraceStats(cameraId?: string, since?: number): {
    count: number;
    e2e_ms: { avg: number; p50: number; p95: number };
    perception_ms: { avg: number; p50: number; p95: number };
    vlm_ms: { avg: number; p50: number; p95: number };
    vlm_prep_ms: { avg: number; p50: number; p95: number };
    vlm_analyze_ms: { avg: number; p50: number; p95: number };
    vlm_finalize_ms: { avg: number; p50: number; p95: number };
    detection_ms: { avg: number; p50: number; p95: number };
    memory_blocking_ms: { avg: number; p50: number; p95: number };
    memory_ms: { avg: number; p50: number; p95: number };
  } {
    let whereClause = "WHERE 1=1";
    const params: (string | number)[] = [];
    if (cameraId) { whereClause += " AND camera_id = ?"; params.push(cameraId); }
    if (since) { whereClause += " AND created_at >= ?"; params.push(since); }

    const rows = this.db.prepare(`
      SELECT e2e_ms, perception_ms, vlm_ms, detection_ms, memory_blocking_ms, memory_ms, trace_json
      FROM traces ${whereClause} ORDER BY created_at DESC
    `).all(...params) as Array<{
      e2e_ms: number;
      perception_ms: number;
      vlm_ms: number | null;
      detection_ms: number | null;
      memory_blocking_ms: number | null;
      memory_ms: number | null;
      trace_json: string;
    }>;

    const count = rows.length;
    if (count === 0) {
      const zero = { avg: 0, p50: 0, p95: 0 };
      return {
        count: 0,
        e2e_ms: zero,
        perception_ms: zero,
        vlm_ms: zero,
        vlm_prep_ms: zero,
        vlm_analyze_ms: zero,
        vlm_finalize_ms: zero,
        detection_ms: zero,
        memory_blocking_ms: zero,
        memory_ms: zero,
      };
    }

    function percentiles(values: number[]): { avg: number; p50: number; p95: number } {
      if (values.length === 0) return { avg: 0, p50: 0, p95: 0 };
      const sorted = [...values].sort((a, b) => a - b);
      const avg = Math.round(sorted.reduce((s, v) => s + v, 0) / sorted.length);
      const p50 = sorted[Math.floor(sorted.length * 0.5)]!;
      const p95 = sorted[Math.floor(sorted.length * 0.95)]!;
      return { avg, p50, p95 };
    }
    const traceLatency = (key: keyof PipelineTrace["latencies"]): number[] => rows.flatMap((row) => {
      try {
        const parsed = JSON.parse(row.trace_json) as PipelineTrace;
        const value = parsed.latencies[key];
        return typeof value === "number" && Number.isFinite(value) ? [value] : [];
      } catch {
        return [];
      }
    });

    return {
      count,
      e2e_ms: percentiles(rows.map(r => r.e2e_ms)),
      perception_ms: percentiles(rows.map(r => r.perception_ms)),
      vlm_ms: percentiles(rows.filter(r => r.vlm_ms != null).map(r => r.vlm_ms!)),
      vlm_prep_ms: percentiles(traceLatency("vlm_prep_ms")),
      vlm_analyze_ms: percentiles(traceLatency("vlm_analyze_ms")),
      vlm_finalize_ms: percentiles(traceLatency("vlm_finalize_ms")),
      detection_ms: percentiles(rows.filter(r => r.detection_ms != null).map(r => r.detection_ms!)),
      memory_blocking_ms: percentiles(rows.filter(r => r.memory_blocking_ms != null).map(r => r.memory_blocking_ms!)),
      memory_ms: percentiles(rows.filter(r => r.memory_ms != null).map(r => r.memory_ms!)),
    };
  }

  /** Remove all dashboard-visible pipeline data and generated media. */
  clearAll(): void {
    this.db.exec(`
      DELETE FROM notification_log;
      DELETE FROM pipeline_errors;
      DELETE FROM traces;
      DELETE FROM llm_calls;
      DELETE FROM pipeline_log;
      DELETE FROM media_files;
      DELETE FROM memory_write_failures;
      DELETE FROM subject_bindings;
      DELETE FROM subject_counters;
    `);
    try {
      rmSync(this.mediaDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup only.
    }
    if (!existsSync(this.mediaDir)) mkdirSync(this.mediaDir, { recursive: true });
  }

  /** Remove dashboard-visible pipeline data and generated media for one source. */
  clearCamera(cameraId: string): void {
    const segmentIds = (this.db.prepare(`
      SELECT segment_id FROM pipeline_log WHERE camera_id = ?
    `).all(cameraId) as unknown as Array<{ segment_id: string }>).map((row) => row.segment_id);
    this.deleteRowsBySegmentIds("notification_log", segmentIds);
    this.deleteRowsBySegmentIds("pipeline_errors", segmentIds);
    this.deleteRowsBySegmentIds("traces", segmentIds);
    this.deleteRowsBySegmentIds("llm_calls", segmentIds);
    this.deleteRowsBySegmentIds("memory_write_failures", segmentIds);
    this.db.prepare("DELETE FROM notification_log WHERE camera_id = ?").run(cameraId);
    this.db.prepare("DELETE FROM pipeline_errors WHERE camera_id = ?").run(cameraId);
    this.db.prepare("DELETE FROM traces WHERE camera_id = ?").run(cameraId);
    this.db.prepare("DELETE FROM llm_calls WHERE camera_id = ?").run(cameraId);
    this.db.prepare("DELETE FROM pipeline_log WHERE camera_id = ?").run(cameraId);
    this.db.prepare("DELETE FROM memory_write_failures WHERE camera_id = ?").run(cameraId);
    this.db.prepare("DELETE FROM subject_bindings WHERE camera_id = ?").run(cameraId);
    this.db.prepare("DELETE FROM subject_counters WHERE camera_id = ?").run(cameraId);
    const mediaRows = this.db.prepare("SELECT file_path FROM media_files WHERE camera_id = ?").all(cameraId) as Array<{ file_path: string }>;
    this.db.prepare("DELETE FROM media_files WHERE camera_id = ?").run(cameraId);
    for (const row of mediaRows) {
      try {
        unlinkSync(row.file_path);
      } catch {
        // Best-effort cleanup only.
      }
    }
    try {
      rmSync(join(this.mediaDir, cameraId), { recursive: true, force: true });
    } catch {
      // Best-effort cleanup only.
    }
  }

  close(): void {
    this.db.close();
  }
}
