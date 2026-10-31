import type { BoundingBox, Segment } from "@reflectworld/shared";
import { renderDIdAnnotations } from "../set-of-mark.js";
import type { DetectionRegistry } from "../did-registry.js";
import type { DIdEntry } from "../types.js";
import type { VlmFrameResizeOptions } from "./types.js";

const DEFAULT_VLM_FRAME_SHORT_EDGE = 432;
const DEFAULT_VLM_FRAME_JPEG_QUALITY = 75;

export interface FrameDimensions {
  width: number;
  height: number;
}

interface VlmDidSelectionDebugBbox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VlmDidSelectionReject {
  did: string;
  frame_idx: number;
  class_name: string;
  reason: string;
  bbox: VlmDidSelectionDebugBbox;
  area_ratio?: number;
  width_ratio?: number;
}

export async function resolveFrameDimensions(
  frames: Segment["frames"],
): Promise<Map<number, FrameDimensions>> {
  const entries = await Promise.all(frames.map(async (frame, index): Promise<[number, FrameDimensions] | undefined> => {
    if (frame.width && frame.height) return [index, { width: frame.width, height: frame.height }];
    try {
      const sharp = (await import("sharp")).default;
      const meta = await sharp(Buffer.from(frame.data, "base64")).metadata();
      if (!meta.width || !meta.height) return undefined;
      return [index, { width: meta.width, height: meta.height }];
    } catch {
      return undefined;
    }
  }));
  return new Map(entries.filter((entry): entry is [number, FrameDimensions] => entry != null));
}

export async function resizeFramesForVlm(
  frames: Segment["frames"],
  options?: VlmFrameResizeOptions,
): Promise<Segment["frames"]> {
  if (frames.length === 0) return frames;
  if (!options?.enabled) return frames;
  const shortEdge = options.shortEdge ?? DEFAULT_VLM_FRAME_SHORT_EDGE;
  const jpegQuality = options.jpegQuality ?? DEFAULT_VLM_FRAME_JPEG_QUALITY;
  return Promise.all(frames.map((frame) => resizeFrameForVlm(frame, shortEdge, jpegQuality)));
}

async function resizeFrameForVlm(
  frame: Segment["frames"][number],
  targetShortEdge: number,
  jpegQuality: number,
): Promise<Segment["frames"][number]> {
  const buf = Buffer.from(frame.data, "base64");
  try {
    const sharp = (await import("sharp")).default;
    const meta = await sharp(buf).metadata();
    const width = frame.width ?? meta.width;
    const height = frame.height ?? meta.height;
    if (!width || !height) return frame;

    const shortEdge = Math.min(width, height);
    if (shortEdge <= targetShortEdge) {
      return { ...frame, width, height };
    }

    const scale = targetShortEdge / shortEdge;
    const resizedWidth = Math.max(1, Math.round(width * scale));
    const resizedHeight = Math.max(1, Math.round(height * scale));
    const resized = await sharp(buf)
      .resize({ width: resizedWidth, height: resizedHeight, fit: "fill" })
      .jpeg({ quality: jpegQuality })
      .toBuffer();

    return {
      ...frame,
      data: resized.toString("base64"),
      width: resizedWidth,
      height: resizedHeight,
    };
  } catch {
    return frame;
  }
}

function scaleBoundingBoxForFrame(
  bbox: BoundingBox,
  originalDimensions: FrameDimensions | undefined,
  vlmFrame: Segment["frames"][number],
): BoundingBox {
  const originalWidth = originalDimensions?.width;
  const originalHeight = originalDimensions?.height;
  const vlmWidth = vlmFrame.width;
  const vlmHeight = vlmFrame.height;
  if (!originalWidth || !originalHeight || !vlmWidth || !vlmHeight) return bbox;
  const scaleX = vlmWidth / originalWidth;
  const scaleY = vlmHeight / originalHeight;
  return {
    x: bbox.x * scaleX,
    y: bbox.y * scaleY,
    width: bbox.width * scaleX,
    height: bbox.height * scaleY,
  };
}

function scaleDIdEntryForVlmFrame(
  entry: DIdEntry,
  originalDimensions: FrameDimensions | undefined,
  vlmFrame: Segment["frames"][number],
): DIdEntry {
  return {
    ...entry,
    bbox: scaleBoundingBoxForFrame(entry.bbox, originalDimensions, vlmFrame),
    face: entry.face
      ? {
        ...entry.face,
        bbox: scaleBoundingBoxForFrame(entry.face.bbox, originalDimensions, vlmFrame),
      }
      : undefined,
  };
}

export async function annotateVlmFramesWithDIds(
  originalFrames: Segment["frames"],
  vlmFrames: Segment["frames"],
  registry: DetectionRegistry,
  frameDimensions?: Map<number, FrameDimensions>,
  selectableDidIds?: Set<string>,
): Promise<Segment["frames"]> {
  return Promise.all(
    vlmFrames.map(async (frame, frameIndex) => {
      const entries = registry.byFrame(frameIndex).filter((entry) =>
        !selectableDidIds || selectableDidIds.has(entry.did)
      );
      if (entries.length === 0) return frame;
      const originalFrame = originalFrames[frameIndex];
      const originalDimensions = frameDimensions?.get(frameIndex)
        ?? (originalFrame?.width && originalFrame.height
          ? { width: originalFrame.width, height: originalFrame.height }
          : undefined);
      const scaledEntries = entries.map((entry) =>
        scaleDIdEntryForVlmFrame(entry, originalDimensions, frame)
      );
      try {
        const buf = Buffer.from(frame.data, "base64");
        const annotated = await renderDIdAnnotations(buf, scaledEntries);
        return { ...frame, data: annotated.toString("base64") };
      } catch {
        return frame;
      }
    }),
  );
}

export function resolveVlmSelectableDIds(input: {
  registry: DetectionRegistry;
  frameDimensions: Map<number, FrameDimensions>;
}): {
  selectableDidIds: Set<string>;
  rejected: VlmDidSelectionReject[];
} {
  const entries = input.registry.all();
  const selectableDidIds = new Set<string>();
  for (const entry of entries) {
    selectableDidIds.add(entry.did);
  }
  return { selectableDidIds, rejected: [] };
}
