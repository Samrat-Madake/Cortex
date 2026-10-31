// packages/percept/src/set-of-mark.ts
// Draw labelled detection bboxes on keyframe images (Set-of-Mark annotation).

import type { BoundingBox } from "@reflectworld/shared";
import type { DIdEntry } from "./types.js";

/** A single annotation to overlay on a keyframe. */
export interface MarkAnnotation {
  /** Globally unique label, e.g. "E:entity_abc" or "kf0_P1". */
  label: string;
  /** Bounding box in pixel coordinates. */
  bbox: BoundingBox;
  /** CSS-style hex color for the box, e.g. "#00ff00". */
  color: string;
}

/** Default colors for different annotation types. */
export const MARK_COLORS = {
  entity: "#00ff00",   // green — face-ReID'd
  person: "#ff6600",   // orange — anonymous person
  vehicle: "#3399ff",  // blue
  animal: "#ff33cc",   // pink
} as const;

/**
 * Render Set-of-Mark annotations on an image buffer.
 *
 * Overlays labelled rectangles using sharp composite. Labels are rendered as
 * small white text on a colored background strip above the bbox.
 *
 * @returns Annotated JPEG buffer.
 */
export async function renderSetOfMark(
  imageBuffer: Buffer,
  annotations: MarkAnnotation[],
): Promise<Buffer> {
  if (annotations.length === 0) return imageBuffer;

  const sharp = (await import("sharp")).default;
  const meta = await sharp(imageBuffer).metadata();
  const imgW = meta.width ?? 1;
  const imgH = meta.height ?? 1;

  // Build SVG overlay with all boxes + labels
  const rects: string[] = [];
  for (const ann of annotations) {
    const x = Math.max(0, Math.round(ann.bbox.x));
    const y = Math.max(0, Math.round(ann.bbox.y));
    const w = Math.min(imgW - x, Math.round(ann.bbox.width));
    const h = Math.min(imgH - y, Math.round(ann.bbox.height));
    if (w < 2 || h < 2) continue;

    const color = ann.color;
    // Rectangle outline
    rects.push(
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${color}" stroke-width="2"/>`,
    );

    // Label background + text above bbox
    const fontSize = Math.max(10, Math.min(16, Math.round(h * 0.12)));
    const labelW = Math.min(w, ann.label.length * fontSize * 0.65 + 8);
    const labelH = fontSize + 4;
    const labelY = Math.max(0, y - labelH);

    rects.push(
      `<rect x="${x}" y="${labelY}" width="${labelW}" height="${labelH}" fill="${color}" rx="2"/>`,
    );
    rects.push(
      `<text x="${x + 4}" y="${labelY + fontSize}" font-family="monospace" font-size="${fontSize}" fill="white" font-weight="bold">${escapeXml(ann.label)}</text>`,
    );
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${imgW}" height="${imgH}">${rects.join("")}</svg>`;

  return sharp(imageBuffer)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 85 })
    .toBuffer();
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Build annotation list from detection results + face ReID results.
 *
 * @param keyframeIdx Index of this keyframe within the segment.
 * @param detections Detection boxes on this keyframe.
 * @param reidBboxes Bboxes covered by face ReID (Path A).
 * @param entityLabels Map from bbox key → entity label for Path A targets.
 * @param iouThreshold IoU above which a Path B detection is suppressed by Path A.
 */
export function buildAnnotations(
  keyframeIdx: number,
  detections: Array<{ label: string; confidence: number; bbox: BoundingBox }>,
  entityLabels: Map<string, string>,
  reidBboxes: BoundingBox[],
  iouThreshold: number = 0.5,
): MarkAnnotation[] {
  const annotations: MarkAnnotation[] = [];
  const classCounts: Record<string, number> = {};

  // Pre-build entity label entries with their bboxes for IoU matching.
  const entityEntries = Array.from(entityLabels.entries()).map(([key, label]) => {
    const [x, y, w, h] = key.split(",").map(Number);
    return { bbox: { x: x!, y: y!, width: w!, height: h! }, label };
  });

  for (const det of detections) {
    // Check if this detection is covered by a Path A (face ReID) bbox.
    // Use IoU matching, not exact key, because face cluster best bbox may
    // come from a different frame than the keyframe detection.
    let entityLabel: string | undefined;
    let bestEntityIoU = 0;
    for (const entry of entityEntries) {
      const iou = computeIoU(det.bbox, entry.bbox);
      if (iou > bestEntityIoU) {
        bestEntityIoU = iou;
        entityLabel = entry.label;
      }
    }
    if (entityLabel && bestEntityIoU > iouThreshold) {
      annotations.push({
        label: `E:${entityLabel}`,
        bbox: det.bbox,
        color: MARK_COLORS.entity,
      });
      continue;
    }

    // Suppress if overlaps with any Path A bbox
    if (reidBboxes.some((rb) => computeIoU(det.bbox, rb) > iouThreshold)) {
      continue;
    }

    // Path B: assign kf{idx}_{class}{seq} label
    const cls = classPrefix(det.label);
    classCounts[cls] = (classCounts[cls] ?? 0) + 1;
    const label = `kf${keyframeIdx}_${cls}${classCounts[cls]}`;
    const color = det.label === "person"
      ? MARK_COLORS.person
      : /car|truck|bus|motorcycle|bicycle|boat|train/.test(det.label)
        ? MARK_COLORS.vehicle
        : MARK_COLORS.animal;

    annotations.push({ label, bbox: det.bbox, color });
  }

  return annotations;
}

function classPrefix(label: string): string {
  if (label === "person") return "P";
  if (/car|truck|bus|motorcycle|bicycle|boat|train/.test(label)) return "V";
  if (/dog|cat|bird|horse|sheep|cow/.test(label)) return "A";
  return "O";
}

function computeIoU(a: BoundingBox, b: BoundingBox): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  if (inter === 0) return 0;
  const areaA = a.width * a.height;
  const areaB = b.width * b.height;
  return inter / (areaA + areaB - inter);
}

// ── D{id} Annotation Renderer (subject proposal) ──

const VEHICLE_LABELS = new Set(["car", "truck", "bus", "motorcycle", "bicycle", "boat", "train"]);
const ANIMAL_LABELS = new Set(["dog", "cat", "bird", "horse", "cow", "sheep"]);

/**
 * Resolve annotation color for a DIdEntry.
 *
 * Priority: entity-linked person (green) > plain person (orange)
 *           > vehicle (blue) > animal (pink) > other (white).
 */
function didColor(entry: DIdEntry): string {
  if (entry.face?.entity_id) return "#00ff00";
  const cls = entry.class_name.toLowerCase();
  if (cls === "person") return "#ff6600";
  if (VEHICLE_LABELS.has(cls)) return "#3399ff";
  if (ANIMAL_LABELS.has(cls)) return "#ff33cc";
  return "#ffffff";
}

/**
 * Build the label string for a DIdEntry.
 *
 * With entity_id: "D7 (abc123)" (last 6 chars).
 * Without:        "D7".
 */
function didLabel(entry: DIdEntry): string {
  const eid = entry.face?.entity_id;
  if (eid) {
    const suffix = eid.length > 6 ? eid.slice(-6) : eid;
    return `${entry.did} (${suffix})`;
  }
  return entry.did;
}

/**
 * Draw D{id} annotations on a frame image.
 * Each detection box gets a colored rectangle + D{id} label.
 * Colors: person=orange (#ff6600), person+entity=green (#00ff00),
 *         vehicle=blue (#3399ff), animal=pink (#ff33cc), other=white
 * Labels: "D{id}" or "D{id} ({entity_id last 6 chars})" if face.entity_id exists.
 * Face bbox drawn as dashed inner rectangle if present.
 */
export async function renderDIdAnnotations(
  imageBuffer: Buffer,
  entries: DIdEntry[],
): Promise<Buffer> {
  if (entries.length === 0) return imageBuffer;

  const sharp = (await import("sharp")).default;
  const meta = await sharp(imageBuffer).metadata();
  const imgW = meta.width ?? 1;
  const imgH = meta.height ?? 1;

  const svgParts: string[] = [];

  for (const entry of entries) {
    const color = didColor(entry);
    const label = didLabel(entry);

    // Clamp detection bbox to image bounds
    const x = Math.max(0, Math.round(entry.bbox.x));
    const y = Math.max(0, Math.round(entry.bbox.y));
    const w = Math.min(imgW - x, Math.round(entry.bbox.width));
    const h = Math.min(imgH - y, Math.round(entry.bbox.height));
    if (w < 2 || h < 2) continue;

    // Detection rectangle outline
    svgParts.push(
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${color}" stroke-width="2"/>`,
    );

    // Label background + text above bbox
    const fontSize = Math.max(10, Math.min(16, Math.round(h * 0.12)));
    const labelW = Math.min(w, label.length * fontSize * 0.65 + 8);
    const labelH = fontSize + 4;
    const labelY = Math.max(0, y - labelH);

    svgParts.push(
      `<rect x="${x}" y="${labelY}" width="${labelW}" height="${labelH}" fill="${color}" rx="2"/>`,
    );
    svgParts.push(
      `<text x="${x + 4}" y="${labelY + fontSize}" font-family="monospace" font-size="${fontSize}" fill="white" font-weight="bold">${escapeXml(label)}</text>`,
    );

    // Dashed inner rectangle for face bbox (if present)
    if (entry.face) {
      const fx = Math.max(0, Math.round(entry.face.bbox.x));
      const fy = Math.max(0, Math.round(entry.face.bbox.y));
      const fw = Math.min(imgW - fx, Math.round(entry.face.bbox.width));
      const fh = Math.min(imgH - fy, Math.round(entry.face.bbox.height));
      if (fw >= 2 && fh >= 2) {
        svgParts.push(
          `<rect x="${fx}" y="${fy}" width="${fw}" height="${fh}" fill="none" stroke="${color}" stroke-width="1" stroke-dasharray="4,3"/>`,
        );
      }
    }
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${imgW}" height="${imgH}">${svgParts.join("")}</svg>`;

  return sharp(imageBuffer)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 85 })
    .toBuffer();
}
