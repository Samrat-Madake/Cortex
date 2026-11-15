import { describe, it, expect, beforeEach } from "vitest";
import {
  parseSubjectProposalOutput,
  parseSubjectProposalEnvelopeOnly,
  isReidWritableFace,
  type ParsedSubjectProposalTarget,
} from "../vlm-output-parser.js";
import { DetectionRegistry, type RawDetection } from "../did-registry.js";
import type { WorkingMemoryTarget } from "../types.js";

// ── Helpers ──

/** Face data that passes gallery append policy (5 landmarks + quality + sane pitch/blur). */
const WRITABLE_FACE_DEFAULTS = {
  landmarks: Array.from({ length: 5 }, (_, i) => ({ x: 20 + i * 5, y: 20 + i * 3 })),
  quality: 0.9,
  pose: { yaw: 10, pitch: 5, roll: 0 },
  sharpness: 200,
};

function makeDet(
  cls: string,
  confidence: number,
  x = 0,
  y = 0,
  w = 100,
  h = 100,
): RawDetection {
  return { class_name: cls, confidence, bbox: { x, y, width: w, height: h } };
}

function makeWmTarget(
  targetId: string,
  className: string,
  opts: Partial<WorkingMemoryTarget> = {},
): WorkingMemoryTarget {
  return {
    target_id: targetId,
    class_name: className,
    appearance: "default appearance",
    crop_path: "/tmp/crop.jpg",
    last_seen_segment_id: "seg-0",
    last_seen_timestamp: Date.now(),
    segments_seen: 1,
    segments_missed: 0,
    ...opts,
  };
}

function attachWritableFace(reg: DetectionRegistry, did: string, embedding: number[], quality = 0.9): void {
  reg.associateFace(did, {
    bbox: { x: 10, y: 10, width: 40, height: 40 },
    embedding,
    quality,
    sharpness: 200,
    pose: { yaw: 0, pitch: 0, roll: 0 },
    landmarks: WRITABLE_FACE_DEFAULTS.landmarks,
  });
}

/** Build a minimal VlmSubjectProposalTarget JSON array string. */
function toJson(
  targets: Array<{
    type: string;
    bbox_ids: string[];
    matched_wm_target?: string | null;
    appearance?: string;
    behavior?: string;
  }>,
): string {
  return JSON.stringify(
    targets.map((t) => ({
      type: t.type,
      bbox_ids: t.bbox_ids,
      matched_wm_target: t.matched_wm_target ?? null,
      appearance: t.appearance ?? "some appearance",
      behavior: t.behavior,
    })),
  );
}

// ── Tests ──

describe("parseSubjectProposalOutput", () => {
  let reg: DetectionRegistry;

  beforeEach(() => {
    reg = new DetectionRegistry();
  });

  // ── JSON parse errors ──

  describe("JSON parsing", () => {
    it("returns error for invalid JSON", () => {
      const result = parseSubjectProposalOutput("not json", reg, []);
      expect(result.targets).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatch(/JSON parse error/);
    });

    it("returns error for JSON without targets field", () => {
      const result = parseSubjectProposalOutput('{"foo": 1}', reg, []);
      expect(result.targets).toHaveLength(0);
      expect(result.errors[0]).toBe("VLM output has no targets array");
    });

    it("accepts {targets: [...]} wrapper format", () => {
      reg.addFrame(0, [makeDet("person", 0.9)]);
      const json = JSON.stringify({ targets: [{ type: "person", bbox_ids: ["D0"], appearance: "test" }] });
      const result = parseSubjectProposalOutput(json, reg, []);
      expect(result.targets).toHaveLength(1);
      expect(result.targets[0]!.bbox_ids).toEqual(["D0"]);
    });

    it("coerces non-string appearance and behavior fields instead of crashing downstream", () => {
      reg.addFrame(0, [makeDet("person", 0.9)]);
      const json = JSON.stringify({
        targets: [{
          type: "person",
          bbox_ids: ["D0"],
          appearance: ["blue jacket", { hat: "red" }],
          behavior: { action: "walking" },
        }],
      });
      const result = parseSubjectProposalOutput(json, reg, []);
      expect(result.targets).toHaveLength(1);
      expect(result.targets[0]!.appearance).toBe('blue jacket, {"hat":"red"}');
      expect(result.targets[0]!.behavior).toBe('{"action":"walking"}');
    });

    it("merges split target_details into targets by first bbox id", () => {
      reg.addFrame(0, [makeDet("person", 0.9)]);
      const json = JSON.stringify({
        targets: [{
          type: "person",
          bbox_ids: ["D0"],
          matched_wm_target: null,
        }],
        target_details: [{
          target_ref: "D0",
          appearance: "dark jacket",
          behavior: "walking",
        }],
      });
      const result = parseSubjectProposalOutput(json, reg, []);
      expect(result.targets).toHaveLength(1);
      expect(result.targets[0]!.appearance).toBe("dark jacket");
      expect(result.targets[0]!.behavior).toBe("walking");
    });

    it("ignores tid entirely when live-latency target correlation is disabled", () => {
      reg.addFrame(0, [makeDet("person", 0.9), makeDet("person", 0.9, 150)]);
      const json = JSON.stringify({
        targets: [{
          tid: "t1",
          type: "person",
          bbox_ids: ["D0"],
          matched_wm_target: null,
        }, {
          tid: "t2",
          type: "person",
          bbox_ids: ["D1"],
          matched_wm_target: null,
        }],
        target_details: [{
          tid: "t2",
          appearance: "index zero detail",
          behavior: "index zero behavior",
        }, {
          tid: "t1",
          appearance: "index one detail",
          behavior: "index one behavior",
        }],
      });
      const result = parseSubjectProposalOutput(json, reg, []);
      expect(result.errors).not.toContain("target[0]: missing required temporary tid");
      expect(result.targets).toHaveLength(2);
      expect(result.targets[0]!.tid).toBeUndefined();
      expect(result.targets[1]!.tid).toBeUndefined();
      expect(result.targets[0]!.appearance).toBe("index zero detail");
      expect(result.targets[1]!.appearance).toBe("index one detail");
    });

    it("requires unique temporary tids when live-latency target correlation is enabled", () => {
      reg.addFrame(0, [makeDet("person", 0.9), makeDet("person", 0.9, 150)]);
      const json = JSON.stringify({
        targets: [{
          type: "person",
          bbox_ids: ["D0"],
          matched_wm_target: null,
        }, {
          tid: "t1",
          type: "person",
          bbox_ids: ["D1"],
          matched_wm_target: null,
        }, {
          tid: "t1",
          type: "person",
          bbox_ids: ["D1"],
          matched_wm_target: null,
        }],
      });
      const result = parseSubjectProposalOutput(json, reg, [], { requireTid: true });
      expect(result.errors).toContain("target[0]: missing required temporary tid");
      expect(result.errors).toContain('target[2]: duplicate temporary tid "t1"');
    });

    it("merges live-latency target_details by tid only", () => {
      reg.addFrame(0, [makeDet("person", 0.9), makeDet("person", 0.9, 150)]);
      const json = JSON.stringify({
        targets: [{
          tid: "t1",
          type: "person",
          bbox_ids: ["D0"],
          matched_wm_target: null,
        }, {
          tid: "t2",
          type: "person",
          bbox_ids: ["D1"],
          matched_wm_target: null,
        }],
        target_details: [{
          tid: "t2",
          target_ref: "D0",
          appearance: "second person",
          behavior: "waiting",
        }, {
          tid: "t1",
          target_ref: "D1",
          appearance: "first person",
          behavior: "speaking",
        }],
      });
      const result = parseSubjectProposalOutput(json, reg, [], { requireTid: true });
      expect(result.targets).toHaveLength(2);
      expect(result.targets[0]!.appearance).toBe("first person");
      expect(result.targets[0]!.behavior).toBe("speaking");
      expect(result.targets[1]!.appearance).toBe("second person");
      expect(result.targets[1]!.behavior).toBe("waiting");
    });

    it("does not merge target_details for duplicated live-latency tids", () => {
      reg.addFrame(0, [makeDet("person", 0.9), makeDet("person", 0.9, 150)]);
      const json = JSON.stringify({
        targets: [{
          tid: "t1",
          type: "person",
          bbox_ids: ["D0"],
          matched_wm_target: null,
        }, {
          tid: "t1",
          type: "person",
          bbox_ids: ["D1"],
          matched_wm_target: null,
        }],
        target_details: [{
          tid: "t1",
          appearance: "ambiguous duplicated detail",
          behavior: "ambiguous behavior",
        }],
      });
      const result = parseSubjectProposalOutput(json, reg, [], { requireTid: true });
      expect(result.errors).toContain('target[1]: duplicate temporary tid "t1"');
      expect(result.targets).toHaveLength(2);
      expect(result.targets[0]!.tid).toBeUndefined();
      expect(result.targets[1]!.tid).toBeUndefined();
      expect(result.targets[0]!.appearance).toBe("");
      expect(result.targets[1]!.appearance).toBe("");
      expect(result.targets[0]!.behavior).toBeUndefined();
      expect(result.targets[1]!.behavior).toBeUndefined();
    });

    it("infers a missing matched_wm_target from a clear pending face continuity match", () => {
      reg.addFrame(0, [makeDet("person", 0.9)]);
      attachWritableFace(reg, "D0", [1, 0, 0]);

      const wm = makeWmTarget("wm_t2", "person", {
        pending_face_embeddings: [{
          embedding: [1, 0.01, 0],
          quality: 0.8,
          segment_id: "seg-prev",
          did: "D9",
        }],
      });
      const result = parseSubjectProposalOutput(toJson([{
        type: "person",
        bbox_ids: ["D0"],
        matched_wm_target: null,
      }]), reg, [wm]);

      expect(result.targets).toHaveLength(1);
      expect(result.targets[0]!.matched_wm_target).toBe("wm_t2");
      expect(result.targets[0]!.matched_wm_target_source).toBe("pending_face");
      expect(result.errors.join("\n")).toContain('matched_wm_target inferred as "wm_t2" from pending face continuity');
    });

    it("does not infer pending face continuity when multiple WM candidates are too close", () => {
      reg.addFrame(0, [makeDet("person", 0.9)]);
      attachWritableFace(reg, "D0", [1, 0, 0]);

      const wmA = makeWmTarget("wm_a", "person", {
        pending_face_embeddings: [{
          embedding: [1, 0.01, 0],
          quality: 0.8,
          segment_id: "seg-prev",
          did: "D9",
        }],
      });
      const wmB = makeWmTarget("wm_b", "person", {
        pending_face_embeddings: [{
          embedding: [1, 0.02, 0],
          quality: 0.8,
          segment_id: "seg-prev",
          did: "D10",
        }],
      });
      const result = parseSubjectProposalOutput(toJson([{
        type: "person",
        bbox_ids: ["D0"],
        matched_wm_target: null,
      }]), reg, [wmA, wmB]);

      expect(result.targets).toHaveLength(1);
      expect(result.targets[0]!.matched_wm_target).toBeNull();
      expect(result.targets[0]!.matched_wm_target_source).toBeUndefined();
      expect(result.errors.join("\n")).toContain("pending face continuity ambiguous");
    });

    it("preserves direct-path-compatible top-level content fields", () => {
      reg.addFrame(0, [makeDet("person", 0.9)]);
      const json = JSON.stringify({
        summary: "A person enters.",
        detailed_summary: "A person in a blue jacket enters the porch and looks toward the door.",
        security_risk: false,
        notify_user: true,
        content_type: "activity",
        key_modality: "visual",
        is_static_scene: false,
        event_boundary: true,
        event_summary: "A new porch event begins as a person approaches the door.",
        retrieval_compact: ["blue jacket", "front door approach"],
        segment_policy_exit_met: true,
        custom_fields: { scene_changed: true, count: 1, ignored: { nested: true } },
        targets: [{
          type: "person",
          bbox_ids: ["D0"],
          appearance: "blue jacket",
          identity: { name: "Alex", evidence: "addressed as Alex", source: "spoken" },
        }],
      });
      const result = parseSubjectProposalOutput(json, reg, []);
      expect(result.summary).toBe("A person enters.");
      expect(result.detailed_summary).toContain("blue jacket");
      expect(result.security_risk).toBe(false);
      expect(result.notify_user).toBe(true);
      expect(result.content_type).toBe("activity");
      expect(result.key_modality).toBe("visual");
      expect(result.is_static_scene).toBe(false);
      expect(result.event_boundary).toBe(true);
      expect(result.event_summary).toContain("porch event");
      expect(result.retrieval_compact).toEqual(["blue jacket", "front door approach"]);
      expect(result.segment_policy_exit_met).toBe(true);
      expect(result.custom_fields).toEqual({ scene_changed: true, count: 1 });
      expect(result.targets[0]?.identity).toEqual({ name: "Alex", evidence: "addressed as Alex", source: "spoken" });
    });

    it("preserves explicit visible_nameplate identity source", () => {
      reg.addFrame(0, [makeDet("person", 0.9)]);
      const json = JSON.stringify({
        targets: [{
          type: "person",
          bbox_ids: ["D0"],
          appearance: "focused speaker",
          identity: {
            name: "Michael Dell",
            evidence: "A lower-third nameplate is attached to the focused speaker.",
            source: "visible_nameplate",
          },
        }],
      });
      const result = parseSubjectProposalOutput(json, reg, []);
      expect(result.targets[0]?.identity).toEqual({
        name: "Michael Dell",
        evidence: "A lower-third nameplate is attached to the focused speaker.",
        source: "visible_nameplate",
      });
    });
  });

  // ── Rule 1: D{id} existence ──

  describe("Rule 1: D{id} existence", () => {
    it("valid D{id} references pass through", () => {
      reg.addFrame(0, [makeDet("person", 0.9)]);
      const json = toJson([
        { type: "person", bbox_ids: ["D0"], appearance: "man in blue" },
      ]);
      const result = parseSubjectProposalOutput(json, reg, []);
      expect(result.errors).toHaveLength(0);
      expect(result.targets).toHaveLength(1);
      expect(result.targets[0]!.bbox_ids).toEqual(["D0"]);
    });

    it("hallucinated D{id} is dropped with error", () => {
      reg.addFrame(0, [makeDet("person", 0.9)]);
      const json = toJson([
        {
          type: "person",
          bbox_ids: ["D0", "D99"],
          appearance: "man in blue",
        },
      ]);
      const result = parseSubjectProposalOutput(json, reg, []);
      expect(result.targets[0]!.bbox_ids).toEqual(["D0"]);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatch(/D99.*not found/);
    });

    it("D{id} outside selectable allow-list is dropped with error", () => {
      reg.addFrame(0, [
        makeDet("person", 0.9),
        makeDet("person", 0.8, 120, 0),
      ]);
      const json = toJson([
        {
          type: "person",
          bbox_ids: ["D0", "D1"],
          appearance: "person",
        },
      ]);
      const result = parseSubjectProposalOutput(json, reg, [], {
        allowedDidIds: new Set(["D1"]),
      });
      expect(result.targets).toHaveLength(1);
      expect(result.targets[0]!.bbox_ids).toEqual(["D1"]);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatch(/D0.*not selectable/);
    });
  });

  // ── Rule 2: D{id} uniqueness ──

  describe("Rule 2: D{id} uniqueness", () => {
    it("duplicate D{id} without search entity is removed from every claimant", () => {
      reg.addFrame(0, [makeDet("person", 0.9)]);
      reg.addFrame(1, [makeDet("person", 0.8, 200)]);
      const json = toJson([
        { type: "person", bbox_ids: ["D0", "D1"], appearance: "first target" },
        { type: "person", bbox_ids: ["D0"], appearance: "second target" },
      ]);
      const result = parseSubjectProposalOutput(json, reg, []);
      expect(result.targets[0]!.bbox_ids).toEqual(["D1"]);
      // Second target had only D0 which was duplicated → empty bbox_ids → dropped
      expect(result.targets).toHaveLength(1);
      expect(result.errors.some((e) => e.includes("no search entity available"))).toBe(
        true,
      );
    });

    it("duplicate D{id} with unmatched search entity is removed from every claimant", () => {
      reg.addFrame(0, [makeDet("person", 0.9)]);
      reg.addFrame(1, [makeDet("person", 0.85)]);
      reg.associateFace("D0", {
        ...WRITABLE_FACE_DEFAULTS,
        bbox: { x: 10, y: 10, width: 30, height: 30 },
        entity_id: "entity-X",
        quality: 0.9,
        embedding: [0.1, 0.2, 0.3],
      });
      reg.associateFace("D1", {
        ...WRITABLE_FACE_DEFAULTS,
        bbox: { x: 10, y: 10, width: 30, height: 30 },
        quality: 0.85,
        embedding: [0.4, 0.5, 0.6],
      });

      const json = toJson([
        { type: "person", bbox_ids: ["D0", "D1"], appearance: "first target" },
        { type: "person", bbox_ids: ["D0"], appearance: "second target" },
      ]);
      const result = parseSubjectProposalOutput(json, reg, []);

      expect(result.targets).toHaveLength(1);
      expect(result.targets[0]!.bbox_ids).toEqual(["D1"]);
      expect(result.errors.some((e) => e.includes("duplicate removed from all targets"))).toBe(true);
      expect(result.targets[0]!.reid_unsafe_reason).toBeUndefined();
      expect(result.targets[0]!.entity_id).toBeUndefined();
      expect(result.targets[0]!.entity_id_source).toBeNull();
      expect(result.targets[0]!.gallery_candidates).toHaveLength(0);
      expect(result.targets[0]!.upsert_candidate?.did).toBe("D1");
    });

    it("duplicate D{id} with search entity is kept only on the wm_entity matching target", () => {
      reg.addFrame(0, [makeDet("person", 0.9)]);
      reg.addFrame(1, [makeDet("person", 0.85, 200, 0)]);
      reg.associateFace("D0", {
        ...WRITABLE_FACE_DEFAULTS,
        bbox: { x: 10, y: 10, width: 30, height: 30 },
        entity_id: "entity-jensen",
        match_score: 0.88,
        quality: 0.3,
        pose: { yaw: 90, pitch: 10, roll: 0 },
        embedding: [0.1, 0.2, 0.3],
      });

      const json = toJson([
        { type: "person", bbox_ids: ["D0", "D1"], matched_wm_target: "wm_host", appearance: "host" },
        { type: "person", bbox_ids: ["D0"], matched_wm_target: "wm_jensen", appearance: "jensen" },
      ]);
      const wmTargets = [
        makeWmTarget("wm_host", "person", { entity_id: "entity-host" }),
        makeWmTarget("wm_jensen", "person", { entity_id: "entity-jensen" }),
      ];

      const result = parseSubjectProposalOutput(json, reg, wmTargets);

      expect(result.targets).toHaveLength(2);
      const host = result.targets.find((t) => t.matched_wm_target === "wm_host")!;
      const jensen = result.targets.find((t) => t.matched_wm_target === "wm_jensen")!;
      expect(host.bbox_ids).toEqual(["D1"]);
      expect(host.entity_id).toBe("entity-host");
      expect(host.entity_id_source).toBe("wm_inherited");
      expect(jensen.bbox_ids).toEqual(["D0"]);
      expect(jensen.entity_id).toBe("entity-jensen");
      expect(jensen.entity_id_source).toBe("wm_inherited");
      expect(jensen.gallery_candidates).toHaveLength(0);
      expect(result.errors.some((e) => e.includes("belongs to target[1]"))).toBe(true);
    });
  });

  // ── Rule 3: Type consistency ──

  describe("Rule 3: type consistency", () => {
    it("removes D{id} with mismatched class", () => {
      reg.addFrame(0, [
        makeDet("person", 0.9),
        makeDet("dog", 0.8, 200),
      ]);
      const json = toJson([
        { type: "person", bbox_ids: ["D0", "D1"], appearance: "mixed" },
      ]);
      const result = parseSubjectProposalOutput(json, reg, []);
      // D0 (person) passes, D1 (dog → animal) is removed
      expect(result.targets[0]!.bbox_ids).toEqual(["D0"]);
      expect(result.errors.some((e) => e.includes("mismatches target type"))).toBe(
        true,
      );
    });

    it("drops unsupported vehicle ids because vehicles are not D{id} targets", () => {
      reg.addFrame(0, [
        makeDet("car", 0.9),
        makeDet("truck", 0.85, 200),
      ]);
      const json = toJson([
        { type: "vehicle", bbox_ids: ["D0", "D1"], appearance: "vehicles" },
      ]);
      const result = parseSubjectProposalOutput(json, reg, []);
      expect(result.targets).toHaveLength(0);
      expect(result.errors.some((e) => e.includes("all bbox_ids removed"))).toBe(true);
    });

    it("normalizes animal subtypes correctly", () => {
      reg.addFrame(0, [
        makeDet("dog", 0.9),
        makeDet("cat", 0.85, 200),
      ]);
      const json = toJson([
        { type: "animal", bbox_ids: ["D0", "D1"], appearance: "pets" },
      ]);
      const result = parseSubjectProposalOutput(json, reg, []);
      expect(result.targets[0]!.bbox_ids).toEqual(["D0", "D1"]);
      expect(result.errors).toHaveLength(0);
    });
  });

  // ── Rule 4: Same-frame cannot-link ──

  describe("Rule 4: same-frame cannot-link for person", () => {
    it("keeps highest confidence person per frame", () => {
      reg.addFrame(0, [
        makeDet("person", 0.9, 0, 0),
        makeDet("person", 0.7, 200, 0),
      ]);
      const json = toJson([
        { type: "person", bbox_ids: ["D0", "D1"], appearance: "two persons" },
      ]);
      const result = parseSubjectProposalOutput(json, reg, []);
      // D0 (0.9) wins over D1 (0.7) for frame 0
      expect(result.targets[0]!.bbox_ids).toEqual(["D0"]);
      expect(
        result.errors.some((e) => e.includes("same-frame cannot-link")),
      ).toBe(true);
    });

    it("same-frame cannot-link keeps the surviving D{id} eligible for current ReID writes", () => {
      reg.addFrame(0, [
        makeDet("person", 0.9, 0, 0),
        makeDet("person", 0.8, 200, 0),
      ]);
      reg.associateFace("D0", {
        ...WRITABLE_FACE_DEFAULTS,
        bbox: { x: 10, y: 10, width: 30, height: 30 },
        entity_id: "entity-X",
        quality: 0.9,
        embedding: [0.1, 0.2, 0.3],
      });
      reg.associateFace("D1", {
        ...WRITABLE_FACE_DEFAULTS,
        bbox: { x: 210, y: 10, width: 30, height: 30 },
        quality: 0.85,
        embedding: [0.4, 0.5, 0.6],
      });

      const result = parseSubjectProposalOutput(toJson([
        { type: "person", bbox_ids: ["D0", "D1"], appearance: "mixed people" },
      ]), reg, []);

      expect(result.targets[0]!.bbox_ids).toEqual(["D0"]);
      expect(result.targets[0]!.reid_unsafe_reason).toBeUndefined();
      expect(result.targets[0]!.entity_id).toBe("entity-X");
      expect(result.targets[0]!.entity_id_source).toBe("current_reid");
      expect(result.targets[0]!.gallery_candidates).toHaveLength(1);
      expect(result.targets[0]!.gallery_candidates[0]!.did).toBe("D0");
      expect(result.targets[0]!.upsert_candidate).toBeUndefined();
    });

    it("allows multiple person D{id}s from different frames", () => {
      reg.addFrame(0, [makeDet("person", 0.9)]);
      reg.addFrame(1, [makeDet("person", 0.85)]);
      const json = toJson([
        {
          type: "person",
          bbox_ids: ["D0", "D1"],
          appearance: "same person multi-frame",
        },
      ]);
      const result = parseSubjectProposalOutput(json, reg, []);
      expect(result.targets[0]!.bbox_ids).toEqual(["D0", "D1"]);
      expect(result.errors).toHaveLength(0);
    });

    it("does not apply cannot-link to animal targets", () => {
      reg.addFrame(0, [
        makeDet("dog", 0.9, 0, 0),
        makeDet("cat", 0.8, 200, 0),
      ]);
      const json = toJson([
        {
          type: "animal",
          bbox_ids: ["D0", "D1"],
          appearance: "two animals same frame",
        },
      ]);
      const result = parseSubjectProposalOutput(json, reg, []);
      // Animal: no cannot-link, both stay
      expect(result.targets[0]!.bbox_ids).toEqual(["D0", "D1"]);
      expect(result.errors).toHaveLength(0);
    });
  });

  // ── Rule 5: matched_wm_target existence ──

  describe("Rule 5: matched_wm_target existence", () => {
    it("sets null if wm_target not found", () => {
      reg.addFrame(0, [makeDet("person", 0.9)]);
      const json = toJson([
        {
          type: "person",
          bbox_ids: ["D0"],
          matched_wm_target: "wm-ghost",
          appearance: "person",
        },
      ]);
      const result = parseSubjectProposalOutput(json, reg, []);
      expect(result.targets[0]!.matched_wm_target).toBeNull();
      expect(
        result.errors.some((e) => e.includes("wm-ghost") && e.includes("not found")),
      ).toBe(true);
    });

    it("preserves valid wm_target", () => {
      reg.addFrame(0, [makeDet("person", 0.9)]);
      const wm = makeWmTarget("wm-1", "person");
      const json = toJson([
        {
          type: "person",
          bbox_ids: ["D0"],
          matched_wm_target: "wm-1",
          appearance: "person",
        },
      ]);
      const result = parseSubjectProposalOutput(json, reg, [wm]);
      expect(result.targets[0]!.matched_wm_target).toBe("wm-1");
    });
  });

  // ── Rule 6: matched_wm_target class consistency ──

  describe("Rule 6: matched_wm_target class consistency", () => {
    it("nullifies wm_target with mismatched class", () => {
      reg.addFrame(0, [makeDet("person", 0.9)]);
      const wm = makeWmTarget("wm-vehicle", "car"); // car normalizes to vehicle
      const json = toJson([
        {
          type: "person",
          bbox_ids: ["D0"],
          matched_wm_target: "wm-vehicle",
          appearance: "person",
        },
      ]);
      const result = parseSubjectProposalOutput(json, reg, [wm]);
      expect(result.targets[0]!.matched_wm_target).toBeNull();
      expect(
        result.errors.some((e) => e.includes("class") && e.includes("mismatches")),
      ).toBe(true);
    });

    it("allows normalized class match", () => {
      reg.addFrame(0, [makeDet("dog", 0.9)]);
      const wm = makeWmTarget("wm-cat", "cat"); // cat → animal
      const json = toJson([
        {
          type: "animal",
          bbox_ids: ["D0"],
          matched_wm_target: "wm-cat",
          appearance: "pet",
        },
      ]);
      const result = parseSubjectProposalOutput(json, reg, [wm]);
      expect(result.targets[0]!.matched_wm_target).toBe("wm-cat");
    });
  });

  // ── Rule 7: matched_wm_target one-to-one ──

  describe("Rule 7: matched_wm_target one-to-one", () => {
    it("clears duplicate wm_target claims when no current entity evidence matches", () => {
      reg.addFrame(0, [makeDet("person", 0.9)]);
      reg.addFrame(1, [makeDet("person", 0.85)]);
      reg.addFrame(2, [makeDet("person", 0.8)]);

      const wm = makeWmTarget("wm-shared", "person");
      const json = toJson([
        {
          type: "person",
          bbox_ids: ["D0", "D1"],
          matched_wm_target: "wm-shared",
          appearance: "first",
        },
        {
          type: "person",
          bbox_ids: ["D2"],
          matched_wm_target: "wm-shared",
          appearance: "second",
        },
      ]);
      const result = parseSubjectProposalOutput(json, reg, [wm]);
      expect(result.targets[0]!.matched_wm_target).toBeNull();
      expect(result.targets[1]!.matched_wm_target).toBeNull();
      expect(
        result.errors.some((e) => e.includes("duplicate claim cleared")),
      ).toBe(true);
    });

    it("keeps explicit VLM wm_target semantics and blocks visual writes when all current ReID evidence belongs to another stable entity", () => {
      reg.addFrame(0, [makeDet("person", 0.9)]);
      reg.addFrame(1, [makeDet("person", 0.9, 150, 0)]);
      reg.associateFace("D0", {
        ...WRITABLE_FACE_DEFAULTS,
        bbox: { x: 10, y: 10, width: 30, height: 30 },
        entity_id: "entity-a",
        match_score: 0.9,
        embedding: [0.1, 0.2, 0.3],
      });
      reg.associateFace("D1", {
        ...WRITABLE_FACE_DEFAULTS,
        bbox: { x: 160, y: 10, width: 30, height: 30 },
        entity_id: "entity-b",
        match_score: 0.91,
        embedding: [0.4, 0.5, 0.6],
      });

      const wmA = makeWmTarget("wm-a", "person", { entity_id: "entity-a" });
      const wmB = makeWmTarget("wm-b", "person", { entity_id: "entity-b" });
      const json = toJson([
        { type: "person", bbox_ids: ["D0"], matched_wm_target: "wm-b", appearance: "person A" },
        { type: "person", bbox_ids: ["D1"], matched_wm_target: "wm-a", appearance: "person B" },
      ]);

      const result = parseSubjectProposalOutput(json, reg, [wmA, wmB]);

      expect(result.targets).toHaveLength(2);
      expect(result.targets[0]!.entity_id).toBe("entity-b");
      expect(result.targets[0]!.entity_id_source).toBe("wm_inherited");
      expect(result.targets[0]!.matched_wm_target).toBe("wm-b");
      expect(result.targets[0]!.reid_unsafe_reason).toBe("current_reid_conflicts_with_wm:entity-b");
      expect(result.targets[0]!.display_crop_dids).toEqual([]);
      expect(result.targets[1]!.entity_id).toBe("entity-a");
      expect(result.targets[1]!.entity_id_source).toBe("wm_inherited");
      expect(result.targets[1]!.matched_wm_target).toBe("wm-a");
      expect(result.targets[1]!.reid_unsafe_reason).toBe("current_reid_conflicts_with_wm:entity-a");
      expect(result.targets[1]!.display_crop_dids).toEqual([]);
      expect(result.errors.some((e) => e.includes("corrected from"))).toBe(false);
      expect(result.errors.some((e) => e.includes("cleared matched WM target"))).toBe(false);
    });

    it("keeps explicit anonymous wm_target display-only when current ReID already has another canonical WM target", () => {
      reg.addFrame(0, [makeDet("person", 0.9)]);
      reg.associateFace("D0", {
        ...WRITABLE_FACE_DEFAULTS,
        bbox: { x: 10, y: 10, width: 30, height: 30 },
        entity_id: "entity-a",
        match_score: 0.9,
        embedding: [0.1, 0.2, 0.3],
      });

      const anonymousWm = makeWmTarget("wm-anon", "person");
      const entityWm = makeWmTarget("wm-entity", "person", { entity_id: "entity-a" });
      const json = toJson([
        { type: "person", bbox_ids: ["D0"], matched_wm_target: "wm-anon", appearance: "same visual target" },
      ]);

      const result = parseSubjectProposalOutput(json, reg, [anonymousWm, entityWm]);

      expect(result.targets).toHaveLength(1);
      expect(result.targets[0]!.matched_wm_target).toBe("wm-anon");
      expect(result.targets[0]!.entity_id).toBeUndefined();
      expect(result.targets[0]!.reid_unsafe_reason).toBe("current_reid_belongs_to_existing_wm:entity-a:wm-entity");
      expect(result.errors.some((e) => e.includes("reassigned"))).toBe(false);
    });

    it("fills missing matched_wm_target from clean current ReID entity when a canonical WM target exists", () => {
      reg.addFrame(0, [makeDet("person", 0.9)]);
      reg.associateFace("D0", {
        ...WRITABLE_FACE_DEFAULTS,
        bbox: { x: 10, y: 10, width: 30, height: 30 },
        entity_id: "entity-a",
        match_score: 0.9,
        embedding: [0.1, 0.2, 0.3],
      });

      const wmA = makeWmTarget("wm-a", "person", { entity_id: "entity-a" });
      const json = toJson([
        { type: "person", bbox_ids: ["D0"], matched_wm_target: null, appearance: "person A" },
      ]);

      const result = parseSubjectProposalOutput(json, reg, [wmA]);

      expect(result.targets).toHaveLength(1);
      expect(result.targets[0]!.matched_wm_target).toBe("wm-a");
      expect(result.targets[0]!.entity_id).toBe("entity-a");
      expect(result.errors.some((e) => e.includes("inferred as \"wm-a\""))).toBe(true);
    });

    it("prefers entity-matched WM claim over larger bbox count", () => {
      reg.addFrame(0, [makeDet("person", 0.9)]);
      reg.addFrame(1, [makeDet("person", 0.85)]);
      reg.addFrame(2, [makeDet("person", 0.8)]);
      reg.associateFace("D0", {
        ...WRITABLE_FACE_DEFAULTS,
        bbox: { x: 10, y: 10, width: 30, height: 30 },
        entity_id: "entity-a",
        match_score: 0.9,
        embedding: [0.1, 0.2, 0.3],
      });

      const wm = makeWmTarget("wm-a", "person", { entity_id: "entity-a" });
      const json = toJson([
        { type: "person", bbox_ids: ["D0"], matched_wm_target: "wm-a", appearance: "entity match" },
        { type: "person", bbox_ids: ["D1", "D2"], matched_wm_target: "wm-a", appearance: "larger but anonymous" },
      ]);

      const result = parseSubjectProposalOutput(json, reg, [wm]);

      expect(result.targets[0]!.matched_wm_target).toBe("wm-a");
      expect(result.targets[0]!.entity_id).toBe("entity-a");
      expect(result.targets[0]!.reid_unsafe_reason).toBeUndefined();
      expect(result.targets[1]!.matched_wm_target).toBeNull();
      expect(result.errors.some((e) => e.includes("entity match"))).toBe(true);
    });

    it("clears all duplicate claims for anonymous wm_target", () => {
      reg.addFrame(0, [makeDet("person", 0.9)]);
      reg.addFrame(1, [makeDet("person", 0.85)]);

      const wm = makeWmTarget("wm-anonymous", "person");
      const json = toJson([
        { type: "person", bbox_ids: ["D0"], matched_wm_target: "wm-anonymous", appearance: "first" },
        { type: "person", bbox_ids: ["D1"], matched_wm_target: "wm-anonymous", appearance: "second" },
      ]);

      const result = parseSubjectProposalOutput(json, reg, [wm]);

      expect(result.targets[0]!.matched_wm_target).toBeNull();
      expect(result.targets[1]!.matched_wm_target).toBeNull();
      expect(result.errors.filter((e) => e.includes("duplicate claim cleared"))).toHaveLength(2);
    });
  });

  // ── Rule 8: ReID vs WM entity conflict ──

  describe("Rule 8: ReID vs WM entity conflict", () => {
    it("drops target visual evidence when current ReID conflicts with matched WM entity", () => {
      reg.addFrame(0, [makeDet("person", 0.9)]);
      // Give D0 a face with entity_id
      reg.associateFace("D0", {
        ...WRITABLE_FACE_DEFAULTS,
        bbox: { x: 10, y: 10, width: 30, height: 30 },
        entity_id: "reid-entity-A",
        embedding: [0.1, 0.2, 0.3],
        quality: 0.9,
      });

      const wm = makeWmTarget("wm-1", "person", {
        entity_id: "wm-entity-B",
      });
      const json = toJson([
        {
          type: "person",
          bbox_ids: ["D0"],
          matched_wm_target: "wm-1",
          appearance: "person with conflict",
        },
      ]);
      const result = parseSubjectProposalOutput(json, reg, [wm]);
      // Matched WM keeps semantic ownership; conflicting visual evidence is display-only.
      expect(result.targets).toHaveLength(1);
      expect(result.targets[0]!.entity_id).toBe("wm-entity-B");
      expect(result.targets[0]!.entity_id_source).toBe("wm_inherited");
      expect(result.targets[0]!.matched_wm_target).toBe("wm-1");
      expect(result.targets[0]!.reid_unsafe_reason).toBe("current_reid_conflicts_with_wm:wm-entity-B");
      expect(result.targets[0]!.display_crop_dids).toEqual([]);
      expect(
        result.errors.some((e) => e.includes("current ReID") && e.includes("cleared matched WM target")),
      ).toBe(false);
    });

    it("keeps only Dids that match the WM entity when a target mixes entity evidence", () => {
      reg.addFrame(0, [makeDet("person", 0.9)]);
      reg.addFrame(1, [makeDet("person", 0.88, 120, 0)]);
      reg.associateFace("D0", {
        ...WRITABLE_FACE_DEFAULTS,
        bbox: { x: 10, y: 10, width: 30, height: 30 },
        entity_id: "wm-entity",
        embedding: [0.1, 0.2, 0.3],
        quality: 0.9,
      });
      reg.associateFace("D1", {
        ...WRITABLE_FACE_DEFAULTS,
        bbox: { x: 130, y: 10, width: 30, height: 30 },
        entity_id: "other-entity",
        embedding: [0.8, 0.2, 0.1],
        quality: 0.95,
      });

      const wm = makeWmTarget("wm-1", "person", {
        entity_id: "wm-entity",
      });
      const json = toJson([
        {
          type: "person",
          bbox_ids: ["D0", "D1"],
          matched_wm_target: "wm-1",
          appearance: "mixed person boxes",
        },
      ]);
      const result = parseSubjectProposalOutput(json, reg, [wm]);
      expect(result.targets[0]!.matched_wm_target).toBe("wm-1");
      expect(result.targets[0]!.entity_id).toBe("wm-entity");
      expect(result.targets[0]!.bbox_ids).toEqual(["D0"]);
      expect(result.targets[0]!.reid_unsafe_reason).toBeUndefined();
      expect(result.errors.some((e) => e.includes('dropped "D1"'))).toBe(true);
    });

    it("no conflict when ReID and WM have same entity", () => {
      reg.addFrame(0, [makeDet("person", 0.9)]);
      reg.associateFace("D0", {
        ...WRITABLE_FACE_DEFAULTS,
        bbox: { x: 10, y: 10, width: 30, height: 30 },
        entity_id: "same-entity",
        embedding: [0.1, 0.2],
        quality: 0.8,
      });

      const wm = makeWmTarget("wm-1", "person", {
        entity_id: "same-entity",
      });
      const json = toJson([
        {
          type: "person",
          bbox_ids: ["D0"],
          matched_wm_target: "wm-1",
          appearance: "consistent",
        },
      ]);
      const result = parseSubjectProposalOutput(json, reg, [wm]);
      expect(result.targets[0]!.entity_id).toBe("same-entity");
      expect(result.targets[0]!.matched_wm_target).toBe("wm-1");
      // No conflict error
      expect(
        result.errors.some((e) => e.includes("conflicts")),
      ).toBe(false);
    });
  });

  // ── Entity ID derivation ──

  describe("entity_id derivation", () => {
    it("derives entity_id from single face ReID", () => {
      reg.addFrame(0, [makeDet("person", 0.9)]);
      reg.associateFace("D0", {
        ...WRITABLE_FACE_DEFAULTS,
        bbox: { x: 10, y: 10, width: 30, height: 30 },
        entity_id: "entity-alice",
        quality: 0.85,
        embedding: [0.1, 0.2],
      });

      const json = toJson([
        { type: "person", bbox_ids: ["D0"], appearance: "woman" },
      ]);
      const result = parseSubjectProposalOutput(json, reg, []);
      expect(result.targets[0]!.entity_id).toBe("entity-alice");
      expect(result.targets[0]!.entity_id_source).toBe("current_reid");
    });

    it("uses high-quality side-profile face ReID as stable matched entity evidence", () => {
      reg.addFrame(0, [makeDet("person", 0.9)]);
      reg.associateFace("D0", {
        ...WRITABLE_FACE_DEFAULTS,
        bbox: { x: 10, y: 10, width: 30, height: 30 },
        entity_id: "entity-side-profile",
        quality: 0.86,
        pose: { yaw: 88, pitch: 8, roll: 0 },
        embedding: [0.1, 0.2],
      });

      const result = parseSubjectProposalOutput(toJson([
        { type: "person", bbox_ids: ["D0"], appearance: "side profile" },
      ]), reg, []);

      expect(result.targets[0]!.entity_id).toBe("entity-side-profile");
      expect(result.targets[0]!.entity_id_source).toBe("current_reid");
      expect(result.targets[0]!.gallery_candidates).toEqual([
        expect.objectContaining({
          did: "D0",
          entity_id: "entity-side-profile",
          trust: "confirmed",
          yaw: 88,
        }),
      ]);
    });

    it("does not create a new entity from a single unmatched side-profile face", () => {
      reg.addFrame(0, [makeDet("person", 0.9)]);
      reg.associateFace("D0", {
        ...WRITABLE_FACE_DEFAULTS,
        bbox: { x: 10, y: 10, width: 30, height: 30 },
        quality: 0.9,
        pose: { yaw: 80, pitch: 8, roll: 0 },
        embedding: [0.1, 0.2],
      });

      const result = parseSubjectProposalOutput(toJson([
        { type: "person", bbox_ids: ["D0"], appearance: "unmatched side profile" },
      ]), reg, []);

      expect(result.targets[0]!.entity_id).toBeUndefined();
      expect(result.targets[0]!.entity_id_source).toBeNull();
      expect(result.targets[0]!.upsert_candidate).toBeUndefined();
    });

    it("ignores non-writable face ReID for stable entity derivation", () => {
      reg.addFrame(0, [makeDet("person", 0.9)]);
      reg.associateFace("D0", {
        ...WRITABLE_FACE_DEFAULTS,
        bbox: { x: 10, y: 10, width: 30, height: 30 },
        entity_id: "bad-side-face-entity",
        quality: 0.3,
        pose: { yaw: 90, pitch: 5, roll: 0 },
        embedding: [0.1, 0.2],
      });

      const result = parseSubjectProposalOutput(toJson([
        { type: "person", bbox_ids: ["D0"], appearance: "side face" },
      ]), reg, []);

      expect(result.targets[0]!.entity_id).toBeUndefined();
      expect(result.targets[0]!.entity_id_source).toBeNull();
      expect(result.targets[0]!.gallery_candidates).toHaveLength(0);
      expect(result.targets[0]!.upsert_candidate).toBeUndefined();
    });

    it("inherits WM entity instead of letting non-writable face ReID override it", () => {
      reg.addFrame(0, [makeDet("person", 0.9)]);
      reg.associateFace("D0", {
        ...WRITABLE_FACE_DEFAULTS,
        bbox: { x: 10, y: 10, width: 30, height: 30 },
        entity_id: "bad-side-face-entity",
        quality: 0.3,
        pose: { yaw: 90, pitch: 5, roll: 0 },
        embedding: [0.1, 0.2],
      });
      const wm = makeWmTarget("wm-1", "person", { entity_id: "wm-entity" });

      const result = parseSubjectProposalOutput(toJson([
        { type: "person", bbox_ids: ["D0"], matched_wm_target: "wm-1", appearance: "side face" },
      ]), reg, [wm]);

      expect(result.targets[0]!.matched_wm_target).toBe("wm-1");
      expect(result.targets[0]!.entity_id).toBe("wm-entity");
      expect(result.targets[0]!.entity_id_source).toBe("wm_inherited");
      expect(result.errors.some((e) => e.includes("ReID") && e.includes("conflicts"))).toBe(false);
    });

    it("picks highest quality face when multiple entity_ids conflict", () => {
      reg.addFrame(0, [makeDet("person", 0.9)]);
      reg.addFrame(1, [makeDet("person", 0.85)]);

      reg.associateFace("D0", {
        ...WRITABLE_FACE_DEFAULTS,
        bbox: { x: 10, y: 10, width: 30, height: 30 },
        entity_id: "entity-low-quality",
        quality: 0.75,
        embedding: [0.1],
      });
      reg.associateFace("D1", {
        ...WRITABLE_FACE_DEFAULTS,
        bbox: { x: 10, y: 10, width: 30, height: 30 },
        entity_id: "entity-high-quality",
        quality: 0.95,
        embedding: [0.2],
      });

      const json = toJson([
        { type: "person", bbox_ids: ["D0", "D1"], appearance: "conflict" },
      ]);
      const result = parseSubjectProposalOutput(json, reg, []);
      expect(result.targets[0]!.entity_id).toBe("entity-high-quality");
      expect(result.targets[0]!.entity_id_source).toBe("current_reid");
      expect(result.targets[0]!.reid_unsafe_reason).toBe("mixed_entity_ids:preferred_current_reid:entity-high-quality");
      expect(result.targets[0]!.gallery_candidates).toHaveLength(0);
      expect(result.targets[0]!.upsert_candidate).toBeUndefined();
      // D0 dropped due to conflicting entity
      expect(result.targets[0]!.bbox_ids).not.toContain("D0");
      expect(result.targets[0]!.bbox_ids).toContain("D1");
    });

    it("keeps registry ReID claims intact when duplicate same-frame targets are unsafe", () => {
      reg.addFrame(0, [
        makeDet("person", 0.9, 0, 0, 100, 200),
        makeDet("person", 0.9, 200, 0, 100, 200),
      ]);
      reg.associateFace("D0", {
        ...WRITABLE_FACE_DEFAULTS,
        bbox: { x: 20, y: 20, width: 30, height: 30 },
        entity_id: "entity-same-person",
        quality: 0.95,
        embedding: [0.1],
      });
      reg.associateFace("D1", {
        ...WRITABLE_FACE_DEFAULTS,
        bbox: { x: 220, y: 20, width: 30, height: 30 },
        entity_id: "entity-same-person",
        quality: 0.85,
        embedding: [0.2],
      });
      const json = toJson([
        { type: "person", bbox_ids: ["D0"], appearance: "first duplicate" },
        { type: "person", bbox_ids: ["D1"], appearance: "second duplicate" },
      ]);

      const first = parseSubjectProposalOutput(json, reg, []);
      const second = parseSubjectProposalOutput(json, reg, []);

      expect(first.targets[1]!.entity_id).toBeUndefined();
      expect(first.targets[1]!.reid_unsafe_reason).toBe("duplicate_entity_target:entity-same-person");
      expect(first.errors.some((error) => error.includes("already claimed by target[0]"))).toBe(true);

      expect(second.targets[1]!.entity_id).toBeUndefined();
      expect(second.targets[1]!.reid_unsafe_reason).toBe("duplicate_entity_target:entity-same-person");
      expect(second.errors.some((error) => error.includes("already claimed by target[0]"))).toBe(true);
      expect(reg.get("D1")?.face?.entity_id).toBe("entity-same-person");
    });

    it("keeps live critical/final identity safety output aligned with offline parsing", () => {
      const buildRegistry = () => {
        const registry = new DetectionRegistry();
        registry.addFrame(0, [
          makeDet("person", 0.9, 0, 0, 100, 200),
          makeDet("person", 0.9, 200, 0, 100, 200),
        ]);
        registry.associateFace("D0", {
          ...WRITABLE_FACE_DEFAULTS,
          bbox: { x: 20, y: 20, width: 30, height: 30 },
          entity_id: "entity-same-person",
          quality: 0.95,
          embedding: [0.1],
        });
        registry.associateFace("D1", {
          ...WRITABLE_FACE_DEFAULTS,
          bbox: { x: 220, y: 20, width: 30, height: 30 },
          entity_id: "entity-same-person",
          quality: 0.85,
          embedding: [0.2],
        });
        return registry;
      };
      const json = toJson([
        { type: "person", bbox_ids: ["D0"], appearance: "first duplicate" },
        { type: "person", bbox_ids: ["D1"], appearance: "second duplicate" },
      ]);
      const identitySafety = (result: ReturnType<typeof parseSubjectProposalOutput>) => ({
        targets: result.targets.map((target) => ({
          bbox_ids: target.bbox_ids,
          entity_id: target.entity_id,
          entity_id_source: target.entity_id_source,
          reid_unsafe_reason: target.reid_unsafe_reason,
          gallery_candidates: target.gallery_candidates.length,
          upsert_candidate: Boolean(target.upsert_candidate),
        })),
        errors: result.errors,
      });

      const offline = parseSubjectProposalOutput(json, buildRegistry(), []);
      const sharedRegistry = buildRegistry();
      const liveCritical = parseSubjectProposalOutput(json, sharedRegistry, []);
      const liveFinal = parseSubjectProposalOutput(json, sharedRegistry, []);

      expect(identitySafety(liveCritical)).toEqual(identitySafety(offline));
      expect(identitySafety(liveFinal)).toEqual(identitySafety(offline));
      expect(sharedRegistry.get("D1")?.face?.entity_id).toBe("entity-same-person");
    });

    it("keeps matched WM only for Dids that carry the same entity", () => {
      reg.addFrame(0, [makeDet("person", 0.9)]);
      reg.addFrame(1, [makeDet("person", 0.85)]);

      reg.associateFace("D0", {
        ...WRITABLE_FACE_DEFAULTS,
        bbox: { x: 10, y: 10, width: 30, height: 30 },
        entity_id: "wm-entity",
        quality: 0.75,
        embedding: [0.1],
      });
      reg.associateFace("D1", {
        ...WRITABLE_FACE_DEFAULTS,
        bbox: { x: 10, y: 10, width: 30, height: 30 },
        entity_id: "other-entity",
        quality: 0.95,
        embedding: [0.2],
      });
      const wm = makeWmTarget("wm-1", "person", { entity_id: "wm-entity" });

      const result = parseSubjectProposalOutput(toJson([
        { type: "person", bbox_ids: ["D0", "D1"], matched_wm_target: "wm-1", appearance: "mixed conflict" },
      ]), reg, [wm]);

      expect(result.targets[0]!.entity_id).toBe("wm-entity");
      expect(result.targets[0]!.entity_id_source).toBe("current_reid");
      expect(result.targets[0]!.matched_wm_target).toBe("wm-1");
      expect(result.targets[0]!.bbox_ids).toEqual(["D0"]);
      expect(result.targets[0]!.reid_unsafe_reason).toBeUndefined();
      expect(result.targets[0]!.gallery_candidates).toHaveLength(1);
      expect(result.targets[0]!.upsert_candidate).toBeUndefined();
    });

    it("keeps matched WM identity but drops D{id}s that carry another entity", () => {
      reg.addFrame(0, [makeDet("person", 0.9)]);
      reg.addFrame(1, [makeDet("person", 0.85)]);
      reg.associateFace("D1", {
        ...WRITABLE_FACE_DEFAULTS,
        bbox: { x: 10, y: 10, width: 30, height: 30 },
        entity_id: "contaminating-entity",
        quality: 0.95,
        embedding: [0.2],
      });
      const wm = makeWmTarget("wm-1", "person", { entity_id: "wm-entity" });

      const result = parseSubjectProposalOutput(toJson([
        { type: "person", bbox_ids: ["D0", "D1"], matched_wm_target: "wm-1", appearance: "target anchored on D0" },
      ]), reg, [wm]);

      expect(result.targets[0]!.entity_id).toBe("wm-entity");
      expect(result.targets[0]!.entity_id_source).toBe("wm_inherited");
      expect(result.targets[0]!.matched_wm_target).toBe("wm-1");
      expect(result.targets[0]!.bbox_ids).toEqual(["D0"]);
      expect(result.targets[0]!.reid_unsafe_reason).toBe("current_reid_conflicts_with_wm:wm-entity");
      expect(result.targets[0]!.gallery_candidates).toHaveLength(0);
      expect(result.targets[0]!.upsert_candidate).toBeUndefined();
    });

    it("drops a non-primary current ReID hit when the matched WM target has no stable entity", () => {
      reg.addFrame(0, [makeDet("person", 0.9)]);
      reg.addFrame(1, [makeDet("person", 0.85)]);
      reg.associateFace("D1", {
        ...WRITABLE_FACE_DEFAULTS,
        bbox: { x: 10, y: 10, width: 30, height: 30 },
        entity_id: "contaminating-entity",
        quality: 0.95,
        embedding: [0.2],
      });
      const wm = makeWmTarget("wm-1", "person");

      const result = parseSubjectProposalOutput(toJson([
        { type: "person", bbox_ids: ["D0", "D1"], matched_wm_target: "wm-1", appearance: "target anchored on D0" },
      ]), reg, [wm]);

      expect(result.targets[0]!.entity_id).toBeUndefined();
      expect(result.targets[0]!.entity_id_source).toBeNull();
      expect(result.targets[0]!.matched_wm_target).toBe("wm-1");
      expect(result.targets[0]!.bbox_ids).toEqual(["D0"]);
      expect(result.targets[0]!.reid_unsafe_reason).toBe("current_reid_non_primary_conflicts_with_wm:contaminating-entity");
      expect(result.targets[0]!.gallery_candidates).toHaveLength(0);
      expect(result.targets[0]!.upsert_candidate).toBeUndefined();
    });

    it("inherits entity_id from wm_target when no face entity", () => {
      reg.addFrame(0, [makeDet("person", 0.9)]);
      const wm = makeWmTarget("wm-1", "person", {
        entity_id: "wm-inherited-entity",
      });

      const json = toJson([
        {
          type: "person",
          bbox_ids: ["D0"],
          matched_wm_target: "wm-1",
          appearance: "person",
        },
      ]);
      const result = parseSubjectProposalOutput(json, reg, [wm]);
      expect(result.targets[0]!.entity_id).toBe("wm-inherited-entity");
      expect(result.targets[0]!.entity_id_source).toBe("wm_inherited");
    });

    it("entity_id is undefined when no ReID and no WM entity", () => {
      reg.addFrame(0, [makeDet("person", 0.9)]);
      const json = toJson([
        { type: "person", bbox_ids: ["D0"], appearance: "unknown" },
      ]);
      const result = parseSubjectProposalOutput(json, reg, []);
      expect(result.targets[0]!.entity_id).toBeUndefined();
      expect(result.targets[0]!.entity_id_source).toBeNull();
    });

    it("derives entity_id from single body ReID when no face entity", () => {
      reg.addFrame(0, [makeDet("person", 0.9)]);
      const entry = reg.get("D0")!;
      entry.body = { entity_id: "body-entity-1", quality: 0.7 };

      const json = toJson([
        { type: "person", bbox_ids: ["D0"], appearance: "back view" },
      ]);
      const result = parseSubjectProposalOutput(json, reg, [], { bodyReIdEnabled: true });
      expect(result.targets[0]!.entity_id).toBe("body-entity-1");
      expect(result.targets[0]!.entity_id_source).toBe("current_reid");
    });

    it("keeps same body entity across multiple D{id}s inside one target", () => {
      reg.addFrame(0, [makeDet("person", 0.9)]);
      reg.addFrame(1, [makeDet("person", 0.85)]);
      reg.get("D0")!.body = { entity_id: "body-entity-1", match_score: 0.88, quality: 0.7 };
      reg.get("D1")!.body = { entity_id: "body-entity-1", match_score: 0.91, quality: 0.8 };

      const json = toJson([
        { type: "person", bbox_ids: ["D0", "D1"], appearance: "same person multi-frame" },
      ]);
      const result = parseSubjectProposalOutput(json, reg, [], { bodyReIdEnabled: true });
      expect(result.targets[0]!.entity_id).toBe("body-entity-1");
      expect(result.targets[0]!.bbox_ids).toEqual(["D0", "D1"]);
      expect(reg.get("D0")!.body!.entity_id).toBe("body-entity-1");
      expect(reg.get("D1")!.body!.entity_id).toBe("body-entity-1");
    });

    it("ignores body ReID entity by default", () => {
      reg.addFrame(0, [makeDet("person", 0.9)]);
      const entry = reg.get("D0")!;
      entry.body = { entity_id: "body-entity-disabled", quality: 0.9 };

      const json = toJson([
        { type: "person", bbox_ids: ["D0"], appearance: "back view" },
      ]);
      const result = parseSubjectProposalOutput(json, reg, []);
      expect(result.targets[0]!.entity_id).toBeUndefined();
      expect(result.targets[0]!.entity_id_source).toBeNull();
    });

    it("picks highest quality body as fallback when multiple body entities have no match score", () => {
      reg.addFrame(0, [makeDet("person", 0.9)]);
      reg.addFrame(1, [makeDet("person", 0.85)]);
      const d0 = reg.get("D0")!;
      const d1 = reg.get("D1")!;
      d0.body = { entity_id: "body-low", quality: 0.3 };
      d1.body = { entity_id: "body-high", quality: 0.9 };

      const json = toJson([
        { type: "person", bbox_ids: ["D0", "D1"], appearance: "body conflict" },
      ]);
      const result = parseSubjectProposalOutput(json, reg, [], { bodyReIdEnabled: true });
      expect(result.targets[0]!.entity_id).toBe("body-high");
      expect(result.targets[0]!.entity_id_source).toBe("current_reid");
      expect(result.targets[0]!.bbox_ids).toEqual(["D0", "D1"]);
      expect(d0.body!.entity_id).toBeUndefined();
      expect(d1.body!.entity_id).toBe("body-high");
    });

    it("picks highest body match score over detector quality when body entities conflict", () => {
      reg.addFrame(0, [makeDet("person", 0.9)]);
      reg.addFrame(1, [makeDet("person", 0.85)]);
      const d0 = reg.get("D0")!;
      const d1 = reg.get("D1")!;
      d0.body = { entity_id: "body-high-quality-low-score", match_score: 0.86, quality: 1000 };
      d1.body = { entity_id: "body-low-quality-high-score", match_score: 0.94, quality: 10 };

      const json = toJson([
        { type: "person", bbox_ids: ["D0", "D1"], appearance: "body conflict" },
      ]);
      const result = parseSubjectProposalOutput(json, reg, [], { bodyReIdEnabled: true });
      expect(result.targets[0]!.entity_id).toBe("body-low-quality-high-score");
      expect(result.targets[0]!.entity_id_source).toBe("current_reid");
      expect(result.targets[0]!.bbox_ids).toEqual(["D0", "D1"]);
      expect(d0.body!.entity_id).toBeUndefined();
      expect(d0.body!.match_score).toBeUndefined();
      expect(d1.body!.entity_id).toBe("body-low-quality-high-score");
      expect(result.errors.some((e) => e.includes("body entity conflict") && e.includes("score 0.94"))).toBe(true);
    });

    it("does not let body-only ReID override a matched WM entity", () => {
      reg.addFrame(0, [makeDet("person", 0.9)]);
      reg.get("D0")!.body = { entity_id: "body-entity", match_score: 0.94, quality: 0.9 };

      const wm = makeWmTarget("wm-1", "person", { entity_id: "wm-entity" });
      const json = toJson([
        { type: "person", bbox_ids: ["D0"], matched_wm_target: "wm-1", appearance: "same person" },
      ]);
      const result = parseSubjectProposalOutput(json, reg, [wm], { bodyReIdEnabled: true });
      expect(result.targets[0]!.matched_wm_target).toBe("wm-1");
      expect(result.targets[0]!.entity_id).toBe("wm-entity");
      expect(result.targets[0]!.entity_id_source).toBe("wm_inherited");
      expect(reg.get("D0")!.body!.entity_id).toBeUndefined();
      expect(reg.get("D0")!.body!.match_score).toBeUndefined();
      expect(result.errors.some((e) => e.includes("body ReID entity") && e.includes("WM wins"))).toBe(true);
    });

    it("keeps body ReID as confirmation when it matches the WM entity", () => {
      reg.addFrame(0, [makeDet("person", 0.9)]);
      reg.get("D0")!.body = { entity_id: "same-entity", match_score: 0.94, quality: 0.9 };

      const wm = makeWmTarget("wm-1", "person", { entity_id: "same-entity" });
      const json = toJson([
        { type: "person", bbox_ids: ["D0"], matched_wm_target: "wm-1", appearance: "same person" },
      ]);
      const result = parseSubjectProposalOutput(json, reg, [wm], { bodyReIdEnabled: true });
      expect(result.targets[0]!.matched_wm_target).toBe("wm-1");
      expect(result.targets[0]!.entity_id).toBe("same-entity");
      expect(result.targets[0]!.entity_id_source).toBe("current_reid");
      expect(reg.get("D0")!.body!.entity_id).toBe("same-entity");
      expect(result.errors.some((e) => e.includes("conflicts"))).toBe(false);
    });

    it("keeps registry body claims intact when duplicate same-frame body targets are unsafe", () => {
      reg.addFrame(0, [
        makeDet("person", 0.9, 0, 0),
        makeDet("person", 0.85, 200, 0),
      ]);
      reg.get("D0")!.body = { entity_id: "body-shared", match_score: 0.82, quality: 0.9 };
      reg.get("D1")!.body = { entity_id: "body-shared", match_score: 0.91, quality: 0.7 };

      const json = toJson([
        { type: "person", bbox_ids: ["D0"], appearance: "first person" },
        { type: "person", bbox_ids: ["D1"], appearance: "second person" },
      ]);
      const result = parseSubjectProposalOutput(json, reg, [], { bodyReIdEnabled: true });
      const second = parseSubjectProposalOutput(json, reg, [], { bodyReIdEnabled: true });

      expect(result.targets[0]!.entity_id).toBeUndefined();
      expect(result.targets[0]!.entity_id_source).toBeNull();
      expect(result.targets[0]!.reid_unsafe_reason).toBe("duplicate_entity_target:body-shared");
      expect(result.targets[1]!.entity_id).toBe("body-shared");
      expect(result.targets[1]!.entity_id_source).toBe("current_reid");
      expect(reg.get("D0")!.body!.entity_id).toBe("body-shared");
      expect(reg.get("D0")!.body!.match_score).toBe(0.82);
      expect(reg.get("D1")!.body!.entity_id).toBe("body-shared");
      expect(result.errors.some((e) => e.includes("same-frame conflict") && e.includes("cleared stable entity"))).toBe(true);

      expect(second.targets[0]!.entity_id).toBeUndefined();
      expect(second.targets[0]!.entity_id_source).toBeNull();
      expect(second.targets[0]!.reid_unsafe_reason).toBe("duplicate_entity_target:body-shared");
      expect(second.targets[1]!.entity_id).toBe("body-shared");
      expect(second.errors.some((e) => e.includes("same-frame conflict") && e.includes("cleared stable entity"))).toBe(true);
    });

    it("restores wm continuity when a conflicting body claim is cleared", () => {
      reg.addFrame(0, [
        makeDet("person", 0.9, 0, 0),
        makeDet("person", 0.85, 200, 0),
      ]);
      reg.get("D0")!.body = { entity_id: "body-shared", match_score: 0.82, quality: 0.9 };
      reg.get("D1")!.body = { entity_id: "body-shared", match_score: 0.91, quality: 0.7 };

      const wm = makeWmTarget("wm-first", "person", { entity_id: "wm-first-entity" });
      const json = toJson([
        { type: "person", bbox_ids: ["D0"], matched_wm_target: "wm-first", appearance: "first person" },
        { type: "person", bbox_ids: ["D1"], appearance: "second person" },
      ]);
      const result = parseSubjectProposalOutput(json, reg, [wm], { bodyReIdEnabled: true });
      expect(result.targets[0]!.matched_wm_target).toBe("wm-first");
      expect(result.targets[0]!.entity_id).toBe("wm-first-entity");
      expect(result.targets[0]!.entity_id_source).toBe("wm_inherited");
      expect(result.targets[1]!.entity_id).toBe("body-shared");
      expect(reg.get("D0")!.body!.entity_id).toBeUndefined();
      expect(result.errors.some((e) => e.includes("body ReID entity") && e.includes("WM wins"))).toBe(true);
      expect(result.errors.some((e) => e.includes("cleared for accumulator"))).toBe(false);
    });

    it("face entity takes priority over body entity", () => {
      reg.addFrame(0, [makeDet("person", 0.9)]);
      reg.associateFace("D0", {
        ...WRITABLE_FACE_DEFAULTS,
        bbox: { x: 10, y: 10, width: 30, height: 30 },
        entity_id: "face-entity",
        quality: 0.85,
        embedding: [0.1, 0.2],
      });
      const entry = reg.get("D0")!;
      entry.body = { entity_id: "body-entity", quality: 0.7 };

      const json = toJson([
        { type: "person", bbox_ids: ["D0"], appearance: "face+body" },
      ]);
      const result = parseSubjectProposalOutput(json, reg, []);
      expect(result.targets[0]!.entity_id).toBe("face-entity");
    });
  });

  // ── Gallery candidates ──

  describe("gallery candidates", () => {
    it("confirmed trust for face matching winning entity", () => {
      reg.addFrame(0, [makeDet("person", 0.9)]);
      reg.addFrame(1, [makeDet("person", 0.85)]);

      reg.associateFace("D0", {
        ...WRITABLE_FACE_DEFAULTS,
        bbox: { x: 10, y: 10, width: 30, height: 30 },
        entity_id: "entity-X",
        quality: 0.9,
        embedding: [0.1, 0.2, 0.3],
      });
      reg.associateFace("D1", {
        ...WRITABLE_FACE_DEFAULTS,
        bbox: { x: 10, y: 10, width: 30, height: 30 },
        entity_id: "entity-X",
        quality: 0.8,
        embedding: [0.4, 0.5, 0.6],
      });

      const json = toJson([
        { type: "person", bbox_ids: ["D0", "D1"], appearance: "confirmed" },
      ]);
      const result = parseSubjectProposalOutput(json, reg, []);
      const candidates = result.targets[0]!.gallery_candidates;
      expect(candidates).toHaveLength(2);
      expect(candidates.every((c) => c.trust === "confirmed")).toBe(true);
      expect(candidates.every((c) => c.entity_id === "entity-X")).toBe(true);
    });

    it("unmatched trust for face with no entity_id", () => {
      reg.addFrame(0, [makeDet("person", 0.9)]);
      reg.addFrame(1, [makeDet("person", 0.85)]);

      // D0 has entity via ReID
      reg.associateFace("D0", {
        ...WRITABLE_FACE_DEFAULTS,
        bbox: { x: 10, y: 10, width: 30, height: 30 },
        entity_id: "entity-X",
        quality: 0.9,
        embedding: [0.1, 0.2, 0.3],
      });
      // D1 has embedding but no entity (unmatched face)
      reg.associateFace("D1", {
        ...WRITABLE_FACE_DEFAULTS,
        bbox: { x: 10, y: 10, width: 30, height: 30 },
        quality: 0.7,
        embedding: [0.4, 0.5, 0.6],
      });

      const json = toJson([
        { type: "person", bbox_ids: ["D0", "D1"], appearance: "mixed" },
      ]);
      const result = parseSubjectProposalOutput(json, reg, []);
      const candidates = result.targets[0]!.gallery_candidates;
      expect(candidates).toHaveLength(2);

      const confirmed = candidates.find((c) => c.did === "D0")!;
      expect(confirmed.trust).toBe("confirmed");
      expect(confirmed.entity_id).toBe("entity-X");

      const unmatched = candidates.find((c) => c.did === "D1")!;
      expect(unmatched.trust).toBe("unmatched");
      expect(unmatched.entity_id).toBe("entity-X");
    });

    it("keeps display identity but disables gallery writes for mixed entity targets", () => {
      reg.addFrame(0, [makeDet("person", 0.9)]);
      reg.addFrame(1, [makeDet("person", 0.85)]);
      reg.addFrame(2, [makeDet("person", 0.8)]);

      reg.associateFace("D0", {
        ...WRITABLE_FACE_DEFAULTS,
        bbox: { x: 10, y: 10, width: 30, height: 30 },
        entity_id: "entity-winner",
        quality: 0.95,
        embedding: [0.1],
      });
      reg.associateFace("D1", {
        ...WRITABLE_FACE_DEFAULTS,
        bbox: { x: 10, y: 10, width: 30, height: 30 },
        entity_id: "entity-loser",
        quality: 0.5,
        embedding: [0.2],
      });
      // D2: no face

      const json = toJson([
        {
          type: "person",
          bbox_ids: ["D0", "D1", "D2"],
          appearance: "conflict scenario",
        },
      ]);
      const result = parseSubjectProposalOutput(json, reg, []);
      // D1 was removed by entity conflict in deriveEntityId
      expect(result.targets[0]!.bbox_ids).not.toContain("D1");
      expect(result.targets[0]!.entity_id).toBe("entity-winner");
      expect(result.targets[0]!.entity_id_source).toBe("current_reid");
      expect(result.targets[0]!.reid_unsafe_reason).toBe("mixed_entity_ids:preferred_current_reid:entity-winner");
      expect(result.targets[0]!.gallery_candidates).toHaveLength(0);
      expect(result.targets[0]!.upsert_candidate).toBeUndefined();
    });

    it("merges multiple target entries for the same stable entity inside a segment", () => {
      reg.addFrame(0, [makeDet("person", 0.9)]);
      reg.addFrame(1, [makeDet("person", 0.85)]);

      reg.associateFace("D0", {
        ...WRITABLE_FACE_DEFAULTS,
        bbox: { x: 10, y: 10, width: 30, height: 30 },
        entity_id: "entity-shared",
        match_score: 0.93,
        quality: 0.95,
        embedding: [0.1],
      });
      reg.associateFace("D1", {
        ...WRITABLE_FACE_DEFAULTS,
        bbox: { x: 12, y: 12, width: 28, height: 28 },
        entity_id: "entity-shared",
        match_score: 0.91,
        quality: 0.7,
        embedding: [0.2],
      });

      const wm = makeWmTarget("wm-shared", "person", { entity_id: "entity-shared" });
      const json = toJson([
        { type: "person", bbox_ids: ["D0"], matched_wm_target: "wm-shared", appearance: "primary subject" },
        { type: "person", bbox_ids: ["D1"], matched_wm_target: "wm-shared", appearance: "duplicate subject" },
      ]);
      const result = parseSubjectProposalOutput(json, reg, [wm]);

      expect(result.targets).toHaveLength(1);
      expect(result.targets[0]!.entity_id).toBe("entity-shared");
      expect(result.targets[0]!.entity_id_source).toBe("current_reid");
      expect(result.targets[0]!.matched_wm_target).toBe("wm-shared");
      expect(result.targets[0]!.bbox_ids).toEqual(["D0", "D1"]);
      expect(result.targets[0]!.gallery_candidates.map((candidate) => candidate.did)).toEqual(["D0", "D1"]);
      expect(result.targets[0]!.upsert_candidate).toBeUndefined();
      expect(result.targets[0]!.reid_unsafe_reason).toBeUndefined();
      expect(result.targets[0]!.appearance).toBe("primary subject");
      expect(result.errors).toEqual(expect.arrayContaining([
        expect.stringContaining('targets merged: entity "entity-shared" appeared in 2'),
      ]));
    });
  });

  // ── Upsert candidate ──

  describe("upsert candidate for all-unmatched target", () => {
    it("picks best quality face as upsert_candidate when no entity", () => {
      reg.addFrame(0, [makeDet("person", 0.9)]);
      reg.addFrame(1, [makeDet("person", 0.85)]);

      // Both faces are unmatched (no entity_id)
      reg.associateFace("D0", {
        ...WRITABLE_FACE_DEFAULTS,
        bbox: { x: 10, y: 10, width: 30, height: 30 },
        quality: 0.6,
        embedding: [0.1, 0.2],
      });
      reg.associateFace("D1", {
        ...WRITABLE_FACE_DEFAULTS,
        bbox: { x: 10, y: 10, width: 30, height: 30 },
        quality: 0.9,
        embedding: [0.3, 0.4],
      });

      const json = toJson([
        { type: "person", bbox_ids: ["D0", "D1"], appearance: "unknown" },
      ]);
      const result = parseSubjectProposalOutput(json, reg, []);
      expect(result.targets[0]!.entity_id).toBeUndefined();
      expect(result.targets[0]!.gallery_candidates).toHaveLength(0);
      expect(result.targets[0]!.upsert_candidate).toBeDefined();
      expect(result.targets[0]!.upsert_candidate!.did).toBe("D1"); // best quality
      expect(result.targets[0]!.upsert_candidate!.quality).toBe(0.9);
      expect(result.targets[0]!.upsert_candidate!.embedding).toEqual([0.3, 0.4]);
    });

    it("no upsert_candidate when no faces have embeddings", () => {
      reg.addFrame(0, [makeDet("person", 0.9)]);
      const json = toJson([
        { type: "person", bbox_ids: ["D0"], appearance: "no face" },
      ]);
      const result = parseSubjectProposalOutput(json, reg, []);
      expect(result.targets[0]!.upsert_candidate).toBeUndefined();
    });

    it("keeps upsert_candidate when matched wm_target has no entity_id", () => {
      reg.addFrame(0, [makeDet("person", 0.9)]);
      reg.associateFace("D0", {
        ...WRITABLE_FACE_DEFAULTS,
        bbox: { x: 10, y: 10, width: 30, height: 30 },
        quality: 0.8,
        embedding: [0.7, 0.8],
      });
      const wm = makeWmTarget("wm-1", "person");

      const json = toJson([
        {
          type: "person",
          bbox_ids: ["D0"],
          matched_wm_target: "wm-1",
          appearance: "same person",
        },
      ]);
      const result = parseSubjectProposalOutput(json, reg, [wm]);
      expect(result.targets[0]!.entity_id).toBeUndefined();
      expect(result.targets[0]!.matched_wm_target).toBe("wm-1");
      expect(result.targets[0]!.upsert_candidate).toBeDefined();
      expect(result.targets[0]!.upsert_candidate!.did).toBe("D0");
    });

    it("does not add unmatched gallery candidates for wm_inherited entity", () => {
      reg.addFrame(0, [makeDet("person", 0.9)]);
      reg.associateFace("D0", {
        ...WRITABLE_FACE_DEFAULTS,
        bbox: { x: 10, y: 10, width: 30, height: 30 },
        quality: 0.8,
        embedding: [0.7, 0.8],
      });
      const wm = makeWmTarget("wm-1", "person", {
        entity_id: "wm-entity",
      });
      const json = toJson([
        {
          type: "person",
          bbox_ids: ["D0"],
          matched_wm_target: "wm-1",
          appearance: "inherited",
        },
      ]);
      const result = parseSubjectProposalOutput(json, reg, [wm]);
      expect(result.targets[0]!.entity_id_source).toBe("wm_inherited");
      expect(result.targets[0]!.gallery_candidates).toEqual([]);
      expect(result.targets[0]!.upsert_candidate).toBeUndefined();
    });
  });

  // ── Edge cases ──

  describe("edge cases", () => {
    it("empty targets array parses without error", () => {
      const result = parseSubjectProposalOutput("[]", reg, []);
      expect(result.targets).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
    });

    it("target with all bbox_ids removed is dropped from output", () => {
      reg.addFrame(0, [makeDet("dog", 0.9)]);
      const json = toJson([
        { type: "person", bbox_ids: ["D0"], appearance: "wrong type" },
      ]);
      const result = parseSubjectProposalOutput(json, reg, []);
      expect(result.targets).toHaveLength(0);
      expect(result.errors.some((e) => e.includes("all bbox_ids removed"))).toBe(true);
    });

    it("preserves behavior field when present", () => {
      reg.addFrame(0, [makeDet("person", 0.9)]);
      const json = toJson([
        {
          type: "person",
          bbox_ids: ["D0"],
          appearance: "walking man",
          behavior: "walking towards camera",
        },
      ]);
      const result = parseSubjectProposalOutput(json, reg, []);
      expect(result.targets[0]!.behavior).toBe("walking towards camera");
    });

    it("parses lightweight event context updates from envelope fields", () => {
      const result = parseSubjectProposalEnvelopeOnly(JSON.stringify({
        summary: "An interview continues.",
        event_context_update: {
          setting: "Bloomberg interview in Las Vegas",
          participant_updates: [
            { role: "right-side host", visual_hints: "dark suit and glasses", wm_target_id: "wm_t1" },
            { role: "center guest", visual_hints: "dark blazer and light shirt" },
            { wm_target_id: "wm_t3", role: "legacy guest" },
            { wm_target_id: "not-a-wm-target" },
          ],
        },
      }));

      expect(result.event_context_update).toEqual({
        setting: "Bloomberg interview in Las Vegas",
        participant_updates: [
          { role: "right-side host", visual_hints: "dark suit and glasses" },
          { role: "center guest", visual_hints: "dark blazer and light shirt" },
          { role: "legacy guest" },
        ],
      });
    });

    it("allows matched targets to omit appearance", () => {
      reg.addFrame(0, [makeDet("person", 0.9)]);
      const wm = makeWmTarget("wm-1", "person", { appearance: "person in a red hat" });
      const json = JSON.stringify({
        targets: [{ type: "person", bbox_ids: ["D0"], matched_wm_target: "wm-1", behavior: "walking" }],
      });
      const result = parseSubjectProposalOutput(json, reg, [wm]);
      expect(result.errors).toHaveLength(0);
      expect(result.targets).toHaveLength(1);
      expect(result.targets[0]!.appearance).toBe("");
      expect(result.targets[0]!.matched_wm_target).toBe("wm-1");
    });

    it("handles face with empty embedding array gracefully", () => {
      reg.addFrame(0, [makeDet("person", 0.9)]);
      reg.associateFace("D0", {
        ...WRITABLE_FACE_DEFAULTS,
        bbox: { x: 10, y: 10, width: 30, height: 30 },
        entity_id: "entity-X",
        quality: 0.8,
        embedding: [], // empty
      });
      const json = toJson([
        { type: "person", bbox_ids: ["D0"], appearance: "person" },
      ]);
      const result = parseSubjectProposalOutput(json, reg, []);
      // Empty embedding is not writable, so it must not become stable identity.
      expect(result.targets[0]!.entity_id).toBeUndefined();
      expect(result.targets[0]!.gallery_candidates).toHaveLength(0);
    });

    it("multiple targets with independent D{id}s all pass", () => {
      // Class priority sort: person(3) > animal(2) → D0=person, D1=dog, D2=cat
      reg.addFrame(0, [
        makeDet("person", 0.9, 0),
        makeDet("dog", 0.8, 200),
        makeDet("cat", 0.7, 400),
      ]);
      const json = toJson([
        { type: "person", bbox_ids: ["D0"], appearance: "person" },
        { type: "animal", bbox_ids: ["D1"], appearance: "dog" },
        { type: "animal", bbox_ids: ["D2"], appearance: "cat" },
      ]);
      const result = parseSubjectProposalOutput(json, reg, []);
      expect(result.errors).toHaveLength(0);
      expect(result.targets).toHaveLength(3);
      expect(result.targets[0]!.type).toBe("person");
      expect(result.targets[1]!.type).toBe("animal");
      expect(result.targets[2]!.type).toBe("animal");
    });
  });
});

// ── isReidWritableFace tests ──

describe("isReidWritableFace", () => {
  it("returns false for undefined face", () => {
    expect(isReidWritableFace(undefined)).toBe(false);
  });

  it("returns false for face without embedding", () => {
    expect(isReidWritableFace({
      bbox: { x: 0, y: 0, width: 100, height: 100 },
      landmarks: Array.from({ length: 5 }, () => ({ x: 50, y: 50 })),
      quality: 0.9,
    })).toBe(false);
  });

  it("returns false for face without landmarks", () => {
    expect(isReidWritableFace({
      bbox: { x: 0, y: 0, width: 100, height: 100 },
      embedding: [0.1, 0.2, 0.3],
      quality: 0.9,
    })).toBe(false);
  });

  it("returns false for face with fewer than 5 landmarks", () => {
    expect(isReidWritableFace({
      bbox: { x: 0, y: 0, width: 100, height: 100 },
      embedding: [0.1, 0.2, 0.3],
      landmarks: [{ x: 50, y: 50 }, { x: 60, y: 50 }],
      quality: 0.9,
    })).toBe(false);
  });

  it("returns false for face with quality below 0.5", () => {
    expect(isReidWritableFace({
      bbox: { x: 0, y: 0, width: 100, height: 100 },
      embedding: [0.1, 0.2, 0.3],
      landmarks: Array.from({ length: 5 }, () => ({ x: 50, y: 50 })),
      quality: 0.3,
    })).toBe(false);
  });

  it("returns true for high-quality side-profile yaw up to 90°", () => {
    expect(isReidWritableFace({
      bbox: { x: 0, y: 0, width: 100, height: 100 },
      embedding: [0.1, 0.2, 0.3],
      landmarks: Array.from({ length: 5 }, () => ({ x: 50, y: 50 })),
      quality: 0.9,
      sharpness: 200,
      pose: { yaw: 90, pitch: 10, roll: 0 },
    })).toBe(true);
  });

  it("returns false for unusable yaw beyond side-profile range", () => {
    expect(isReidWritableFace({
      bbox: { x: 0, y: 0, width: 100, height: 100 },
      embedding: [0.1, 0.2, 0.3],
      landmarks: Array.from({ length: 5 }, () => ({ x: 50, y: 50 })),
      quality: 0.9,
      sharpness: 200,
      pose: { yaw: 105, pitch: 10, roll: 0 },
    })).toBe(false);
  });

  it("returns false for face with extreme pitch > 45°", () => {
    expect(isReidWritableFace({
      bbox: { x: 0, y: 0, width: 100, height: 100 },
      embedding: [0.1, 0.2, 0.3],
      landmarks: Array.from({ length: 5 }, () => ({ x: 50, y: 50 })),
      quality: 0.9,
      pose: { yaw: 10, pitch: 50, roll: 0 },
    })).toBe(false);
  });

  it("returns false for blurry face (sharpness < 30)", () => {
    expect(isReidWritableFace({
      bbox: { x: 0, y: 0, width: 100, height: 100 },
      embedding: [0.1, 0.2, 0.3],
      landmarks: Array.from({ length: 5 }, () => ({ x: 50, y: 50 })),
      quality: 0.9,
      sharpness: 15,
    })).toBe(false);
  });

  it("returns true for good face with all criteria met", () => {
    expect(isReidWritableFace({
      bbox: { x: 0, y: 0, width: 100, height: 100 },
      embedding: [0.1, 0.2, 0.3],
      landmarks: Array.from({ length: 5 }, () => ({ x: 50, y: 50 })),
      quality: 0.9,
      sharpness: 200,
      pose: { yaw: 15, pitch: 10, roll: 2 },
    })).toBe(true);
  });

  it("returns false when pose is undefined (degenerate landmarks)", () => {
    expect(isReidWritableFace({
      bbox: { x: 0, y: 0, width: 100, height: 100 },
      embedding: [0.1, 0.2, 0.3],
      landmarks: Array.from({ length: 5 }, () => ({ x: 50, y: 50 })),
      quality: 0.9,
    })).toBe(false);
  });

  it("returns true when sharpness is not measured but pose is valid", () => {
    expect(isReidWritableFace({
      bbox: { x: 0, y: 0, width: 100, height: 100 },
      embedding: [0.1, 0.2, 0.3],
      landmarks: Array.from({ length: 5 }, () => ({ x: 50, y: 50 })),
      quality: 0.9,
      pose: { yaw: 5, pitch: 3, roll: 0 },
    })).toBe(true);
  });

  it("returns false when sharpness is negative (measurement failed)", () => {
    expect(isReidWritableFace({
      bbox: { x: 0, y: 0, width: 100, height: 100 },
      embedding: [0.1, 0.2, 0.3],
      landmarks: Array.from({ length: 5 }, () => ({ x: 50, y: 50 })),
      quality: 0.9,
      pose: { yaw: 5, pitch: 3, roll: 0 },
      sharpness: -1,
    })).toBe(false);
  });
});
