/**
 * SegmentBuilder — converts Cam's FrameResult[] into a shared Segment.
 */

import type { Segment, Frame, SpeechSegment, AudioData } from "@reflectworld/shared";
import type { FrameResult } from "./types.js";

let segmentCounter = 0;

/** Generate a unique segment ID. */
export function generateSegmentId(): string {
  segmentCounter++;
  const ts = Date.now().toString(36);
  const cnt = segmentCounter.toString(36).padStart(4, "0");
  return `seg_${ts}_${cnt}`;
}

/** Convert Cam FrameResult[] to shared Frame[]. */
function toFrames(results: FrameResult[]): Frame[] {
  return results.map((r, i) => ({
    data: r.data,
    timestamp: r.timestamp,
    index: i,
    ...(r.width !== undefined && { width: r.width }),
    ...(r.height !== undefined && { height: r.height }),
    ...(r.detections !== undefined && { detections: r.detections }),
  }));
}

export interface BuildSegmentOptions {
  cameraId: string;
  mode: "snapshot" | "event" | "stream";
  segmentId?: string;
  rawUrl?: string;
  eventHint?: string;
  audioSegments?: SpeechSegment[];
  audioData?: AudioData;
  segmentStartTimestampMs?: number;
  segmentEndTimestampMs?: number;
}

/**
 * Build a Segment from captured frames.
 */
export function buildSegment(
  frames: FrameResult[],
  options: BuildSegmentOptions,
): Segment {
  if (frames.length === 0) {
    throw new Error("Cannot build segment from empty frames");
  }

  const first = frames[0];
  const last = frames[frames.length - 1];
  const startTimestamp = options.segmentStartTimestampMs === undefined
    ? first.timestamp
    : options.segmentStartTimestampMs;
  const endTimestamp = options.segmentEndTimestampMs === undefined
    ? last.timestamp
    : Math.max(last.timestamp, options.segmentEndTimestampMs);
  const durationSec = frames.length === 1
    && options.segmentStartTimestampMs === undefined
    && options.segmentEndTimestampMs === undefined
    ? 0
    : (endTimestamp - startTimestamp) / 1000;

  const segment: Segment = {
    segment_id: options.segmentId ?? generateSegmentId(),
    camera_id: options.cameraId,
    mode: options.mode,
    frames: toFrames(frames),
    raw_url: options.rawUrl ?? "",
    timestamp: startTimestamp,
    duration_sec: Math.max(0, durationSec),
    event_hint: options.eventHint,
  };

  if (options.audioSegments?.length) {
    segment.audio_segments = options.audioSegments;
  }

  if (options.audioData) {
    segment.audio_data = options.audioData;
  }

  return segment;
}

/** Reset the segment counter (for tests). */
export function _resetSegmentCounter(): void {
  segmentCounter = 0;
}
