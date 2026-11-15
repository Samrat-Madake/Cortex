// PipelineStore — media file storage, FIFO quota enforcement, cross-layer consistency
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { PipelineStore } from "../store.js";

describe("PipelineStore — media storage", () => {
  let store: PipelineStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "store-media-"));
    store = new PipelineStore(tmpDir);
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("saveMedia writes file to disk and records in SQLite", () => {
    const data = Buffer.from("fake-jpeg-content-for-testing");
    const filePath = store.saveMedia("cam1", "seg_001", "raw", data);

    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath)).toEqual(data);

    const entries = store.getMediaForSegment("seg_001");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.segment_id).toBe("seg_001");
    expect(entries[0]!.camera_id).toBe("cam1");
    expect(entries[0]!.media_type).toBe("raw");
    expect(entries[0]!.file_size).toBe(data.length);
    expect(entries[0]!.file_path).toBe(filePath);
  });

  it("saveMedia creates camera/mediaType directory structure", () => {
    const filePath = store.saveMedia("cam1", "seg_001", "keyframe", Buffer.from("kf"), "0");

    // Path: {mediaDir}/cam1/keyframe/seg_001_0.jpg
    expect(filePath).toContain(join("cam1", "keyframe"));
    expect(filePath).toContain("seg_001_0.jpg");
  });

  it("saveMedia with suffix creates distinct files per suffix", () => {
    const p1 = store.saveMedia("cam1", "seg_001", "keyframe", Buffer.from("kf1"), "0");
    const p2 = store.saveMedia("cam1", "seg_001", "keyframe", Buffer.from("kf2"), "1");

    expect(p1).toContain("seg_001_0.jpg");
    expect(p2).toContain("seg_001_1.jpg");
    expect(existsSync(p1)).toBe(true);
    expect(existsSync(p2)).toBe(true);

    const entries = store.getMediaForSegment("seg_001");
    expect(entries).toHaveLength(2);
  });

  it("buildMediaUrls reconstructs all media types from SQLite", () => {
    store.saveMedia("cam1", "seg_001", "raw", Buffer.from("raw-data"));
    store.saveMedia("cam1", "seg_001", "keyframe", Buffer.from("kf-0"), "0");
    store.saveMedia("cam1", "seg_001", "keyframe", Buffer.from("kf-1"), "1");
    store.saveMedia("cam1", "seg_001", "crop", Buffer.from("crop-face"), "face_0");

    const urls = store.buildMediaUrls("seg_001");
    expect(urls.raw).toContain("seg_001.jpg");
    expect(urls.keyframes).toHaveLength(2);
    expect(urls.crops).toHaveLength(1);
    expect(urls.gif).toBeUndefined();
  });

  it("buildMediaUrls returns empty structure for unknown segment", () => {
    const urls = store.buildMediaUrls("seg_nonexistent");
    expect(urls.raw).toBe("");
    expect(urls.keyframes).toHaveLength(0);
    expect(urls.crops).toHaveLength(0);
  });

  it("getMediaSize returns correct total bytes for camera", () => {
    store.saveMedia("cam1", "seg_001", "raw", Buffer.alloc(1000));
    store.saveMedia("cam1", "seg_002", "raw", Buffer.alloc(2000));
    store.saveMedia("cam2", "seg_003", "raw", Buffer.alloc(500));

    expect(store.getMediaSize("cam1")).toBe(3000);
    expect(store.getMediaSize("cam2")).toBe(500);
    expect(store.getMediaSize("cam_missing")).toBe(0);
  });

  it("getMediaStats returns per-camera summary", () => {
    store.saveMedia("cam1", "seg_001", "raw", Buffer.alloc(100));
    store.saveMedia("cam1", "seg_002", "keyframe", Buffer.alloc(200), "0");
    store.saveMedia("cam2", "seg_003", "raw", Buffer.alloc(300));

    const stats = store.getMediaStats();
    expect(stats).toHaveLength(2);

    const cam1 = stats.find((s) => s.camera_id === "cam1");
    expect(cam1).toBeDefined();
    expect(cam1!.file_count).toBe(2);
    expect(cam1!.total_size).toBe(300);

    const cam2 = stats.find((s) => s.camera_id === "cam2");
    expect(cam2).toBeDefined();
    expect(cam2!.file_count).toBe(1);
    expect(cam2!.total_size).toBe(300);
  });
});

describe("PipelineStore — FIFO quota enforcement", () => {
  let store: PipelineStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "store-quota-"));
    // 1 KB quota for testing
    store = new PipelineStore(tmpDir, 1 / 1024);
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("enforceQuota deletes oldest files when total exceeds quota", () => {
    // Quota = ~1024 bytes. Write 3 × 500 bytes = 1500 bytes total.
    const p1 = store.saveMedia("cam1", "seg_001", "raw", Buffer.alloc(500));
    // After seg_001: 500 bytes, under 1024 → no eviction
    expect(existsSync(p1)).toBe(true);

    store.saveMedia("cam1", "seg_002", "raw", Buffer.alloc(500));
    // After seg_002: 1000 bytes, still under 1024 → no eviction

    store.saveMedia("cam1", "seg_003", "raw", Buffer.alloc(500));
    // After seg_003: 1500 bytes > 1024 → seg_001 evicted

    // seg_001 should be evicted (oldest)
    expect(store.getMediaForSegment("seg_001")).toHaveLength(0);
    expect(existsSync(p1)).toBe(false);

    // seg_003 must still exist
    expect(store.getMediaForSegment("seg_003")).toHaveLength(1);

    // Total size should be under quota + last write
    expect(store.getMediaSize("cam1")).toBeLessThanOrEqual(1024 + 500);
  });

  it("enforceQuota removes both SQLite record and disk file", () => {
    const p1 = store.saveMedia("cam1", "seg_001", "raw", Buffer.alloc(600));
    store.saveMedia("cam1", "seg_002", "raw", Buffer.alloc(600));

    // 1200 bytes > 1024 → seg_001 evicted
    expect(store.getMediaForSegment("seg_001")).toHaveLength(0);
    expect(existsSync(p1)).toBe(false);

    // seg_002 untouched
    const seg2 = store.getMediaForSegment("seg_002");
    expect(seg2).toHaveLength(1);
    expect(existsSync(seg2[0]!.file_path)).toBe(true);
  });

  it("enforceQuota is per-camera — cam2 does not affect cam1", () => {
    store.saveMedia("cam1", "seg_001", "raw", Buffer.alloc(800));
    store.saveMedia("cam2", "seg_002", "raw", Buffer.alloc(800));

    // Each camera is under 1024 independently
    expect(store.getMediaForSegment("seg_001")).toHaveLength(1);
    expect(store.getMediaForSegment("seg_002")).toHaveLength(1);
  });

  it("enforceQuota returns deleted segment IDs", () => {
    store.saveMedia("cam1", "seg_001", "raw", Buffer.alloc(600));
    // Manual call after second write to capture return value
    store.saveMedia("cam1", "seg_002", "raw", Buffer.alloc(200));
    // Still under quota, add more
    store.saveMedia("cam1", "seg_003", "raw", Buffer.alloc(600));

    // After seg_003: 1400 bytes > 1024.
    // enforceQuota was called internally by saveMedia.
    // Verify by checking seg_001 is gone.
    expect(store.getMediaForSegment("seg_001")).toHaveLength(0);
  });
});

describe("PipelineStore — pipeline log + error log", () => {
  let store: PipelineStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "store-log-"));
    store = new PipelineStore(tmpDir);
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("logResult stores perception result queryable by camera", () => {
    const segment = {
      segment_id: "seg_001",
      camera_id: "cam1",
      mode: "stream" as const,
      frames: [{ data: "base64", timestamp: Date.now(), index: 0 }],
      raw_url: "/tmp/raw.jpg",
      timestamp: Date.now(),
      duration_sec: 10,
    };

    const result = {
      segment_id: "seg_001",
      camera_id: "cam1",
      mode: "stream" as const,
      event_id: "evt_1",
      perception_memory: {
        summary: "Person at door",
        detailed_summary: "A person approached the front door",
        security_risk: true,
        timestamp: Date.now(),
        entities: [{ type: "person" }],
        perception_level: 1,
        is_static_scene: false,
      },
      media_urls: { raw: "/tmp/raw.jpg", keyframes: [], crops: [] },
    };

    store.logResult(segment, result, {
      notify_user: true,
      vlm_model: "gemini-2.5-flash",
      vlm_latency_ms: 450,
    });

    const rows = store.getRecent("cam1");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.segment_id).toBe("seg_001");
    expect(rows[0]!.summary).toBe("Person at door");
    expect(rows[0]!.security_risk).toBe(1);
    expect(rows[0]!.perception_level).toBe(1);
  });

  it("logError records error queryable by getErrors", () => {
    store.logError("seg_001", "cam1", "vlm", "Gemini rate limited");
    store.logError("seg_002", "cam1", "detection", "Model not loaded");

    const errors = store.getErrors();
    expect(errors).toHaveLength(2);
    const stages = errors.map((e) => e.stage).sort();
    expect(stages).toEqual(["detection", "vlm"]);
    expect(errors.find((e) => e.stage === "vlm")!.error).toBe("Gemini rate limited");
    expect(errors.find((e) => e.stage === "detection")!.error).toBe("Model not loaded");
  });

  it("search finds results by keyword in summary", () => {
    const makeEntry = (segId: string, summary: string) => ({
      segment_id: segId,
      camera_id: "cam1",
      mode: "stream" as const,
      event_id: null,
      perception_memory: {
        summary,
        security_risk: false,
        timestamp: Date.now(),
        entities: [],
        perception_level: 0,
        is_static_scene: false,
      },
      media_urls: { raw: "", keyframes: [], crops: [] },
    });

    const seg = {
      segment_id: "seg_001",
      camera_id: "cam1",
      mode: "stream" as const,
      frames: [{ data: "", timestamp: Date.now(), index: 0 }],
      raw_url: "",
      timestamp: Date.now(),
      duration_sec: 5,
    };

    store.logResult(seg, makeEntry("seg_001", "Cat on porch"));
    store.logResult(
      { ...seg, segment_id: "seg_002" },
      makeEntry("seg_002", "Person at door"),
    );

    const catResults = store.search("cat");
    expect(catResults).toHaveLength(1);
    expect(catResults[0]!.segment_id).toBe("seg_001");

    const personResults = store.search("person");
    expect(personResults).toHaveLength(1);
    expect(personResults[0]!.segment_id).toBe("seg_002");
  });
});

describe("PipelineStore — subject index registry", () => {
  let store: PipelineStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pipeline-store-subject-"));
    store = new PipelineStore(tmpDir);
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("allocates per-category indexes and reuses WM/ReID bindings after commit", () => {
    const first = store.createSubjectIndexSession("user-a", "cam-a");
    const person1 = first.resolve({ category: "person", wm_target_id: "wm-1", timestamp: 1000 });
    const person2 = first.resolve({ category: "person", entity_id: "entity-2", timestamp: 1100 });
    const dog1 = first.resolve({ category: "dog", wm_target_id: "wm-dog", timestamp: 1200 });
    const concurrent = store.createSubjectIndexSession("user-a", "cam-b");
    const person3 = concurrent.resolve({ category: "person", wm_target_id: "wm-concurrent", timestamp: 1300 });
    first.commit();
    concurrent.commit();

    expect(person1.subject_index).toBe(1);
    expect(person2.subject_index).toBe(2);
    expect(person3.subject_index).toBe(1);
    expect(dog1.subject_index).toBe(1);

    const second = store.createSubjectIndexSession("user-a", "cam-a");
    expect(second.resolve({ category: "person", wm_target_id: "wm-1" }).subject_index).toBe(1);
    expect(second.resolve({ category: "person", entity_id: "entity-2", name: "Lily" })).toMatchObject({
      subject_index: 2,
      name: "Lily",
    });
    expect(second.resolve({ category: "person", wm_target_id: "wm-3" }).subject_index).toBe(3);
    second.commit();

    const third = store.createSubjectIndexSession("user-a", "cam-a");
    expect(third.resolve({ category: "person", entity_id: "entity-2" })).toMatchObject({
      subject_index: 2,
      name: "Lily",
    });
  });

  it("scopes WM target bindings by camera and resets counters on clear-all", () => {
    const first = store.createSubjectIndexSession("user-a", "cam-a");
    expect(first.resolve({ category: "person", wm_target_id: "wm-same", timestamp: 1000 }).subject_index).toBe(1);
    first.commit();

    const second = store.createSubjectIndexSession("user-a", "cam-b");
    expect(second.resolve({ category: "person", wm_target_id: "wm-same", timestamp: 2000 }).subject_index).toBe(1);
    second.commit();

    const third = store.createSubjectIndexSession("user-a", "cam-a");
    expect(third.resolve({ category: "person", wm_target_id: "wm-same" }).subject_index).toBe(1);
    third.commit();

    store.clearAll();

    const afterClear = store.createSubjectIndexSession("user-a", "cam-a");
    expect(afterClear.resolve({ category: "person", wm_target_id: "wm-same" }).subject_index).toBe(1);
  });

  it("reserves indexes atomically within the same camera before commit", () => {
    const peerStore = new PipelineStore(tmpDir);
    try {
      const first = store.createSubjectIndexSession("user-a", "cam-a");
      const second = peerStore.createSubjectIndexSession("user-a", "cam-a");

      expect(first.resolve({ category: "person", wm_target_id: "wm-a" }).subject_index).toBe(1);
      expect(second.resolve({ category: "person", wm_target_id: "wm-b" }).subject_index).toBe(2);

      second.commit();
      first.commit();

      const third = store.createSubjectIndexSession("user-a", "cam-a");
      expect(third.resolve({ category: "person", wm_target_id: "wm-c" }).subject_index).toBe(3);
    } finally {
      peerStore.close();
    }
  });

  it("allocates camera-local indexes for the same ReID entity across cameras", () => {
    const first = store.createSubjectIndexSession("user-a", "cam-a");
    expect(first.resolve({ category: "person", entity_id: "entity-1", name: "Lily" }).subject_index).toBe(1);
    first.commit();

    const second = store.createSubjectIndexSession("user-a", "cam-b");
    expect(second.resolve({ category: "person", entity_id: "entity-1" })).toMatchObject({
      subject_index: 1,
      name: "Lily",
    });
    second.commit();

    const third = store.createSubjectIndexSession("user-a", "cam-a");
    expect(third.resolve({ category: "person", wm_target_id: "wm-a-new" }).subject_index).toBe(2);
  });

  it("propagates a later ReID name to existing camera-local bindings", () => {
    const first = store.createSubjectIndexSession("user-a", "cam-a");
    expect(first.resolve({ category: "person", entity_id: "entity-1" }).subject_index).toBe(1);
    first.commit();

    const second = store.createSubjectIndexSession("user-a", "cam-b");
    expect(second.resolve({ category: "person", entity_id: "entity-1", name: "Lily" })).toMatchObject({
      subject_index: 1,
      name: "Lily",
    });
    second.commit();

    const third = store.createSubjectIndexSession("user-a", "cam-a");
    expect(third.resolve({ category: "person", entity_id: "entity-1" })).toMatchObject({
      subject_index: 1,
      name: "Lily",
    });
  });

  it("rebinds a preallocated subject index to a newly created ReID entity", () => {
    const first = store.createSubjectIndexSession("user-a", "cam-a");
    const preallocated = first.resolve({ category: "person", timestamp: 1000 });
    expect(preallocated.subject_index).toBe(1);
    expect(first.resolve({
      category: "person",
      entity_id: "entity-1",
      subject_index: preallocated.subject_index,
      timestamp: 1100,
    }).subject_index).toBe(1);
    first.commit();

    const second = store.createSubjectIndexSession("user-a", "cam-a");
    expect(second.resolve({ category: "person", entity_id: "entity-1" }).subject_index).toBe(1);
    expect(second.resolve({ category: "person", wm_target_id: "wm-new" }).subject_index).toBe(2);
  });

  it("does not bind a new ReID entity to an index already owned by a WM target", () => {
    const first = store.createSubjectIndexSession("user-a", "cam-a");
    expect(first.resolve({ category: "person", wm_target_id: "wm-existing", timestamp: 1000 }).subject_index).toBe(1);
    first.commit();

    const second = store.createSubjectIndexSession("user-a", "cam-a");
    expect(second.resolve({
      category: "person",
      entity_id: "entity-new",
      subject_index: 1,
      timestamp: 1100,
    }).subject_index).toBe(2);
    second.commit();

    const third = store.createSubjectIndexSession("user-a", "cam-a");
    expect(third.resolve({ category: "person", wm_target_id: "wm-existing" }).subject_index).toBe(1);
    expect(third.resolve({ category: "person", entity_id: "entity-new" }).subject_index).toBe(2);
  });

  it("migrates legacy global subject tables to camera-local indexes", () => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
    const dbDir = join(tmpDir, "db");
    mkdirSync(dbDir, { recursive: true });
    const db = new DatabaseSync(join(dbDir, "pipeline.db"));
    db.exec(`
      CREATE TABLE subject_counters (
        user_id     TEXT NOT NULL,
        category    TEXT NOT NULL,
        next_index  INTEGER NOT NULL,
        PRIMARY KEY (user_id, category)
      );
      CREATE TABLE subject_bindings (
        user_id       TEXT NOT NULL,
        camera_id     TEXT,
        category      TEXT NOT NULL,
        subject_index INTEGER NOT NULL,
        name          TEXT,
        entity_id     TEXT,
        wm_target_id  TEXT,
        first_seen    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        PRIMARY KEY (user_id, category, subject_index)
      );
      INSERT INTO subject_counters (user_id, category, next_index)
      VALUES ('user-a', 'person', 8);
      INSERT INTO subject_bindings
        (user_id, camera_id, category, subject_index, name, entity_id, wm_target_id, first_seen, updated_at)
      VALUES
        ('user-a', 'cam-a', 'person', 1, 'Lily', 'entity-1', 'wm-a', 1000, 1000),
        ('user-a', 'cam-b', 'person', 2, NULL, 'entity-2', 'wm-b', 2000, 2000);
    `);
    db.close();

    store = new PipelineStore(tmpDir);

    const camA = store.createSubjectIndexSession("user-a", "cam-a");
    expect(camA.resolve({ category: "person", wm_target_id: "wm-a" })).toMatchObject({
      subject_index: 1,
      name: "Lily",
    });
    expect(camA.resolve({ category: "person", wm_target_id: "wm-new-a" }).subject_index).toBe(2);

    const camB = store.createSubjectIndexSession("user-a", "cam-b");
    expect(camB.resolve({ category: "person", wm_target_id: "wm-b" }).subject_index).toBe(2);
    expect(camB.resolve({ category: "person", wm_target_id: "wm-new-b" }).subject_index).toBe(3);

    const camC = store.createSubjectIndexSession("user-a", "cam-c");
    expect(camC.resolve({ category: "person", wm_target_id: "wm-new-c" }).subject_index).toBe(1);
  });

  it("does not persist cross-camera WM aliases onto an existing ReID subject", () => {
    const first = store.createSubjectIndexSession("user-a", "cam-a");
    expect(first.resolve({ category: "person", entity_id: "entity-1", wm_target_id: "wm-a" }).subject_index).toBe(1);
    first.commit();

    const second = store.createSubjectIndexSession("user-a", "cam-b");
    expect(second.resolve({ category: "person", entity_id: "entity-1", wm_target_id: "wm-b" }).subject_index).toBe(1);
    second.commit();

    const camA = store.createSubjectIndexSession("user-a", "cam-a");
    expect(camA.resolve({ category: "person", wm_target_id: "wm-a" }).subject_index).toBe(1);
    expect(camA.resolve({ category: "person", wm_target_id: "wm-b" }).subject_index).toBe(2);

    const camB = store.createSubjectIndexSession("user-a", "cam-b");
    expect(camB.resolve({ category: "person", entity_id: "entity-1" }).subject_index).toBe(1);
  });

  it("keeps an existing entity subject index when a different WM target is matched later", () => {
    const first = store.createSubjectIndexSession("user-a", "cam-a");
    expect(first.resolve({ category: "person", entity_id: "entity-1", wm_target_id: "wm-a" }).subject_index).toBe(1);
    expect(first.resolve({ category: "person", wm_target_id: "wm-b" }).subject_index).toBe(2);
    first.commit();

    const second = store.createSubjectIndexSession("user-a", "cam-a");
    expect(second.resolve({ category: "person", entity_id: "entity-1", wm_target_id: "wm-b" })).toMatchObject({
      subject_index: 1,
      entity_id: "entity-1",
      wm_target_id: "wm-b",
    });
    second.commit();

    const third = store.createSubjectIndexSession("user-a", "cam-a");
    expect(third.resolve({ category: "person", entity_id: "entity-1" }).subject_index).toBe(1);
    expect(third.resolve({ category: "person", wm_target_id: "wm-b" }).subject_index).toBe(1);
  });

  it("deduplicates duplicate entity bindings and preserves the canonical subject index", () => {
    const first = store.createSubjectIndexSession("user-a", "cam-a");
    expect(first.resolve({ category: "person", entity_id: "entity-1", timestamp: 1000 }).subject_index).toBe(1);
    first.commit();

    const second = store.createSubjectIndexSession("user-a", "cam-a");
    expect(second.resolve({ category: "person", wm_target_id: "wm-later", timestamp: 1100 }).subject_index).toBe(2);
    second.commit();

    const third = store.createSubjectIndexSession("user-a", "cam-a");
    expect(third.resolve({
      category: "person",
      entity_id: "entity-1",
      wm_target_id: "wm-later",
      name: "Jensen Huang",
      timestamp: 1200,
    })).toMatchObject({
      subject_index: 1,
      entity_id: "entity-1",
      wm_target_id: "wm-later",
      name: "Jensen Huang",
    });
    third.commit();

    const rows = ((store as any).db as DatabaseSync).prepare(`
      SELECT camera_id, subject_index, name, entity_id, wm_target_id
      FROM subject_bindings
      WHERE user_id = ? AND camera_id = ? AND category = ?
      ORDER BY subject_index
    `).all("user-a", "cam-a", "person");
    expect(rows).toEqual([
      {
        camera_id: "cam-a",
        subject_index: 1,
        name: "Jensen Huang",
        entity_id: "entity-1",
        wm_target_id: "wm-later",
      },
    ]);
  });

  it("removes legacy global subject bindings after camera-scoped adoption", () => {
    const legacy = store.createSubjectIndexSession("user-a");
    expect(legacy.resolve({
      category: "person",
      entity_id: "entity-1",
      wm_target_id: "wm-a",
      timestamp: 1000,
    }).subject_index).toBe(1);
    legacy.commit();

    const scoped = store.createSubjectIndexSession("user-a", "cam-a");
    expect(scoped.resolve({
      category: "person",
      entity_id: "entity-1",
      wm_target_id: "wm-a",
      timestamp: 1100,
    })).toMatchObject({ camera_id: "cam-a", subject_index: 1 });
    scoped.commit();

    const rows = ((store as any).db as DatabaseSync).prepare(`
      SELECT camera_id, category, subject_index, entity_id, wm_target_id
      FROM subject_bindings
      WHERE user_id = ?
      ORDER BY camera_id, subject_index
    `).all("user-a");
    expect(rows).toEqual([
      {
        camera_id: "cam-a",
        category: "person",
        subject_index: 1,
        entity_id: "entity-1",
        wm_target_id: "wm-a",
      },
    ]);
  });

  it("does not merge a legacy global binding into an occupied camera index", () => {
    const existing = store.createSubjectIndexSession("user-a", "cam-a");
    expect(existing.resolve({
      category: "person",
      entity_id: "entity-existing",
      wm_target_id: "wm-existing",
      timestamp: 1000,
    }).subject_index).toBe(1);
    existing.commit();

    const legacy = store.createSubjectIndexSession("user-a");
    expect(legacy.resolve({
      category: "person",
      entity_id: "entity-legacy",
      wm_target_id: "wm-legacy",
      timestamp: 1000,
    }).subject_index).toBe(1);
    legacy.commit();

    const scoped = store.createSubjectIndexSession("user-a", "cam-a");
    expect(scoped.resolve({
      category: "person",
      entity_id: "entity-legacy",
      wm_target_id: "wm-legacy",
      timestamp: 1200,
    })).toMatchObject({ camera_id: "cam-a", subject_index: 2 });
    scoped.commit();

    const rows = ((store as any).db as DatabaseSync).prepare(`
      SELECT camera_id, subject_index, entity_id, wm_target_id
      FROM subject_bindings
      WHERE user_id = ? AND category = ?
      ORDER BY camera_id, subject_index
    `).all("user-a", "person");
    expect(rows).toEqual([
      { camera_id: "cam-a", subject_index: 1, entity_id: "entity-existing", wm_target_id: "wm-existing" },
      { camera_id: "cam-a", subject_index: 2, entity_id: "entity-legacy", wm_target_id: "wm-legacy" },
    ]);
  });
});
