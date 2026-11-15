// packages/percept/src/did-registry.ts
//
// DetectionRegistry: assigns cross-frame continuous D{id} labels to detection boxes.
// Part of subject proposal.

import type { BoundingBox } from "@cortex/shared";
import type { DIdEntry } from "./types.js";
import type { FacePose } from "./analyzers/face-pose.js";

// ── Constants ──

/** Labels eligible for D{id} assignment. */
const TRACKABLE_LABELS = new Set([
  "person", "dog", "cat", "bird", "horse", "cow", "sheep",
]);

/** Maximum trackable detections per frame. */
const PER_FRAME_TOP_K = 8;

// ── Geometry helpers ──

/** Area of a bounding box. */
function bboxArea(b: BoundingBox): number {
  return b.width * b.height;
}

/** Check if point (px, py) is inside bbox. */
function pointInBbox(px: number, py: number, b: BoundingBox): boolean {
  return px >= b.x && px <= b.x + b.width && py >= b.y && py <= b.y + b.height;
}

/** Intersection area of two bounding boxes. */
function intersectionArea(a: BoundingBox, b: BoundingBox): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  if (x2 <= x1 || y2 <= y1) return 0;
  return (x2 - x1) * (y2 - y1);
}

// ── Input type for addFrame ──

/** Raw detection input before D{id} assignment. */
export interface RawDetection {
  bbox: BoundingBox;
  class_name: string;
  confidence: number;
}

// ── Face result type for associateFaces ──

/** Per-face ReID result to be associated with a person D{id}. */
export interface FaceResult {
  bbox: BoundingBox;
  landmarks?: Array<{ x: number; y: number }>;
  pose?: FacePose;
  embedding?: number[];
  entity_id?: string;
  match_score?: number;
  top_entity_id?: string;
  top_score?: number;
  miss_reason?: string;
  quality?: number;
  sharpness?: number;
}

// ── DetectionRegistry ──

export class DetectionRegistry {
  private nextId = 0;
  private entries = new Map<string, DIdEntry>();
  private frameIndex = new Map<number, string[]>();

  /** Total number of D{id} entries. */
  size(): number {
    return this.entries.size;
  }

  /** Get a single entry by D{id}. */
  get(did: string): DIdEntry | undefined {
    return this.entries.get(did);
  }

  /** Get all entries for a given frame index. */
  byFrame(frameIdx: number): DIdEntry[] {
    const dids = this.frameIndex.get(frameIdx);
    if (!dids) return [];
    return dids.map((d) => this.entries.get(d)!);
  }

  /** Return all entries in insertion order. */
  all(): DIdEntry[] {
    return [...this.entries.values()];
  }

  /**
   * Register detections from a single frame.
   *
   * Filters to trackable labels, sorts by confidence × area (descending),
   * takes top-K per frame, and assigns continuous D{id} labels.
   *
   * @returns The newly created DIdEntry[] for this frame.
   */
  addFrame(frameIdx: number, detections: RawDetection[]): DIdEntry[] {
    // Filter to trackable labels only
    const trackable = detections.filter((d) =>
      TRACKABLE_LABELS.has(d.class_name.toLowerCase()),
    );

    // Sort by class priority (person > animal), then confidence × area.
    // Vehicles/objects are scene context for VLM, not target D{id}s.
    const CLASS_PRIORITY: Record<string, number> = {
      person: 3, dog: 2, cat: 2, bird: 2, horse: 2, cow: 2, sheep: 2,
    };
    trackable.sort((a, b) => {
      const pa = CLASS_PRIORITY[a.class_name.toLowerCase()] ?? 0;
      const pb = CLASS_PRIORITY[b.class_name.toLowerCase()] ?? 0;
      if (pa !== pb) return pb - pa;
      return b.confidence * bboxArea(b.bbox) - a.confidence * bboxArea(a.bbox);
    });

    // Suppress person boxes mostly contained within a larger person box BEFORE top-K.
    // Sorted desc by score, so larger/higher-confidence boxes come first.
    const suppressed: typeof trackable = [];
    for (const det of trackable) {
      if (det.class_name.toLowerCase() === "person") {
        const dominated = suppressed.some((kept) => {
          if (kept.class_name.toLowerCase() !== "person") return false;
          const inter = intersectionArea(det.bbox, kept.bbox);
          const smallerArea = bboxArea(det.bbox);
          return smallerArea > 0 && inter / smallerArea > 0.6;
        });
        if (dominated) continue;
      }
      suppressed.push(det);
    }

    // Per-frame top-K
    const selected = suppressed.slice(0, PER_FRAME_TOP_K);

    const results: DIdEntry[] = [];
    const frameDids: string[] = [];

    for (const det of selected) {
      const did = `D${this.nextId}`;
      this.nextId++;

      const entry: DIdEntry = {
        did,
        frame_idx: frameIdx,
        bbox: det.bbox,
        class_name: det.class_name,
        confidence: det.confidence,
      };

      this.entries.set(did, entry);
      frameDids.push(did);
      results.push(entry);
    }

    // Merge with any existing entries for this frame (shouldn't happen normally)
    const existing = this.frameIndex.get(frameIdx);
    if (existing) {
      existing.push(...frameDids);
    } else {
      this.frameIndex.set(frameIdx, frameDids);
    }

    return results;
  }

  /**
   * Associate face data with an existing D{id} entry.
   * No-op if the D{id} doesn't exist.
   */
  associateFace(
    did: string,
    faceData: NonNullable<DIdEntry["face"]>,
  ): void {
    const entry = this.entries.get(did);
    if (!entry) return;
    entry.face = faceData;
  }
}

// ── Standalone associateFaces function ──

/**
 * Associate per-face ReID results to person D{id} entries whose bbox
 * contains the face center (containment check). Fallback to
 * intersection/face_area > 0.8 if no containment match.
 *
 * Only matches faces to "person" class entries on the same frame.
 */
export function associateFaces(
  registry: DetectionRegistry,
  faceResults: Array<{ frame_idx: number; face: FaceResult }>,
): void {
  for (const { frame_idx, face } of faceResults) {
    const frameEntries = registry.byFrame(frame_idx);
    const personEntries = frameEntries.filter(
      (e) => e.class_name.toLowerCase() === "person",
    );
    if (personEntries.length === 0) continue;

    // Face center
    const cx = face.bbox.x + face.bbox.width / 2;
    const cy = face.bbox.y + face.bbox.height / 2;

    // Strategy 1: containment — face center inside person bbox
    let matched: DIdEntry | undefined;
    let bestArea = Infinity;

    for (const entry of personEntries) {
      if (entry.face) continue; // already has a face
      if (pointInBbox(cx, cy, entry.bbox)) {
        // Prefer the smallest containing person bbox (tightest match)
        const area = bboxArea(entry.bbox);
        if (area < bestArea) {
          bestArea = area;
          matched = entry;
        }
      }
    }

    // Strategy 2: fallback — intersection / face_area > 0.8
    if (!matched) {
      let bestRatio = 0;
      const faceArea = bboxArea(face.bbox);
      if (faceArea <= 0) continue;

      for (const entry of personEntries) {
        if (entry.face) continue;
        const ratio = intersectionArea(face.bbox, entry.bbox) / faceArea;
        if (ratio > 0.8 && ratio > bestRatio) {
          bestRatio = ratio;
          matched = entry;
        }
      }
    }

    if (matched) {
      registry.associateFace(matched.did, {
        bbox: face.bbox,
        landmarks: face.landmarks,
        pose: face.pose,
        embedding: face.embedding,
        entity_id: face.entity_id,
        match_score: face.match_score,
        top_entity_id: face.top_entity_id,
        top_score: face.top_score,
        miss_reason: face.miss_reason,
        quality: face.quality,
        sharpness: face.sharpness,
      });
    }
  }
}
