// tests/integration/helpers.ts — Shared utilities for E2E tests
import jpeg from "jpeg-js";
import { vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Frame, Segment } from "@reflectworld/shared";
import type { VlmOutput } from "../../packages/percept/src/types.js";
import type { PipelineDeps } from "../../packages/percept/src/pipeline.js";
import type { VlmSegmentAnalysis } from "../../packages/percept/src/analyzers/vlm-analyzer.js";
import { WorkingMemoryManager } from "../../packages/percept/src/working-memory.js";
import { StrategyManager } from "../../packages/percept/src/strategy-manager.js";
import { MediaUploader, type MediaSaver } from "../../packages/percept/src/media-uploader.js";

// ── Test frame generator ──

/**
 * Generate a minimal valid JPEG frame encoded as base64.
 * Uses jpeg-js to produce a real JPEG (no fake base64 strings).
 */
export function makeTestFrame(
  index: number,
  width = 100,
  height = 100,
  color: [number, number, number] = [128, 128, 128],
): Frame {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = color[0];      // R
    data[i * 4 + 1] = color[1];  // G
    data[i * 4 + 2] = color[2];  // B
    data[i * 4 + 3] = 255;       // A
  }
  const encoded = jpeg.encode({ data, width, height }, 80);
  return {
    data: Buffer.from(encoded.data).toString("base64"),
    timestamp: Date.now() + index * 1000,
    index,
  };
}

// ── Segment builder ──

let segCounter = 0;

export function makeSegment(
  mode: Segment["mode"],
  cameraId: string,
  frameCount: number,
  opts?: { segmentId?: string },
): Segment {
  segCounter++;
  const segmentId = opts?.segmentId ?? `seg_e2e_${segCounter}`;
  const frames = Array.from({ length: frameCount }, (_, i) =>
    makeTestFrame(i, 100, 100, [50 + i * 30, 100, 150]),
  );
  return {
    segment_id: segmentId,
    camera_id: cameraId,
    mode,
    frames,
    raw_url: `/tmp/raw/${cameraId}/${segmentId}.mp4`,
    timestamp: frames[0]?.timestamp ?? Date.now(),
    duration_sec: mode === "snapshot" ? 0 : frameCount,
  };
}

// ── Mock VLM output ──

export const MOCK_VLM_OUTPUT: VlmOutput = {
  summary: "A person in a blue jacket standing at the front door.",
  detailed_summary: "A person wearing a blue jacket arrived at the front door and appears to be waiting.",
  security_risk: false,
  is_static_scene: false,
  notify_user: false,
  main_targets: [
    { type: "person", appearance: "blue jacket", behavior: "standing at door" },
  ],
  raw_response: "{}",
};

export const MOCK_VLM_RESULT: VlmSegmentAnalysis = {
  normalizedJson: MOCK_VLM_OUTPUT.raw_response ?? "{}",
  rawText: MOCK_VLM_OUTPUT.raw_response ?? "{}",
  output: MOCK_VLM_OUTPUT,
  latency_ms: 50,
};

// ── Real MediaSaver backed by temp filesystem ──

export class TempMediaSaver implements MediaSaver {
  public readonly rootDir: string;

  constructor() {
    this.rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "reflectworld-e2e-"));
  }

  saveMedia(
    cameraId: string,
    segmentId: string,
    mediaType: "raw" | "keyframe" | "gif" | "crop",
    data: Buffer,
    suffix?: string,
  ): string {
    const dir = path.join(this.rootDir, cameraId, mediaType);
    fs.mkdirSync(dir, { recursive: true });
    const filename = suffix ? `${segmentId}_${suffix}.jpg` : `${segmentId}.jpg`;
    const filePath = path.join(dir, filename);
    fs.writeFileSync(filePath, data);
    return filePath;
  }

  cleanup(): void {
    fs.rmSync(this.rootDir, { recursive: true, force: true });
  }
}

// ── Build real PipelineDeps with only VLM mocked ──

export function createE2eDeps(opts?: {
  eventTimeoutSec?: number;
  vlmOutput?: VlmOutput;
  mediaSaver?: TempMediaSaver;
}): { deps: PipelineDeps; mediaSaver: TempMediaSaver; mockVlm: { analyze: ReturnType<typeof vi.fn>; analyzeSegment: ReturnType<typeof vi.fn>; setAccessToken: ReturnType<typeof vi.fn>; setUserRules: ReturnType<typeof vi.fn> } } {
  const mediaSaver = opts?.mediaSaver ?? new TempMediaSaver();
  const vlmOutput = opts?.vlmOutput ?? MOCK_VLM_OUTPUT;

  const vlmResult: VlmSegmentAnalysis = {
    normalizedJson: vlmOutput.raw_response ?? "{}",
    rawText: vlmOutput.raw_response ?? "{}",
    output: vlmOutput,
    latency_ms: 10,
  };

  const analyzeSegment = vi.fn().mockResolvedValue(vlmResult);
  const mockVlm = {
    analyze: analyzeSegment,
    analyzeSegment,
    setAccessToken: vi.fn(),
    setUserRules: vi.fn(),
  };

  const deps: PipelineDeps = {
    workingMemory: new WorkingMemoryManager({
      event_timeout_sec: opts?.eventTimeoutSec ?? 30,
    }),
    strategyManager: new StrategyManager({ stubsOnly: true }),
    vlmAnalyzer: mockVlm as unknown as import("../../packages/percept/src/analyzers/vlm-analyzer.js").VlmAnalyzer,
    mediaUploader: new MediaUploader(mediaSaver),
  };

  return { deps, mediaSaver, mockVlm };
}
