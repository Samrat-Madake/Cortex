// packages/percept/src/frame-analyzer.ts
// DO NOT import from @cortex/cam — circular dependency. Import from @cortex/shared instead.
import type { ModelRouter } from "./providers/model-router.js";
import type { FrameDetection } from "@cortex/shared";

// Re-export so consumers can import from percept
export type { FrameDetection } from "@cortex/shared";

/** Minimal frame shape accepted by FrameAnalyzer (base64-encoded JPEG/PNG). */
interface FrameInput {
  data: string;
  timestamp: number;
  width?: number;
  height?: number;
}

export interface FrameAnalyzerDeps {
  router: ModelRouter;
}

export interface FrameAnalysisResult {
  camera_id: string;
  frame_timestamp: number;
  detections: FrameDetection[];
}

export type FrameAnalyzerPolicy = "lossless" | "latest_only";

export interface FrameAnalyzerOptions {
  /** lossless waits behind prior frames for this camera; latest_only drops when the camera is busy. */
  policy?: FrameAnalyzerPolicy;
  onDrop?: (event: {
    camera_id: string;
    frame_timestamp: number;
    dropped_total: number;
    reason: "camera_busy";
  }) => void;
}

interface CameraState {
  busy: boolean;
  chain: Promise<void>;
  dropped: number;
}

/**
 * Runs YOLO detection on individual frames asynchronously.
 * The caller selects a per-camera policy:
 * - lossless: serialize every sampled frame for local files / benchmark.
 * - latest_only: preserve live playback by dropping frames while that camera is busy.
 */
export class FrameAnalyzer {
  private readonly states = new Map<string, CameraState>();
  private readonly router: ModelRouter;

  constructor(deps: FrameAnalyzerDeps) {
    this.router = deps.router;
  }

  /**
   * Starts detection on `frame` for `cameraId`.
   * If a detection is already running, this call is skipped entirely. Callers
   * that process local files may await the returned promise to keep detections
   * attached before the next frame can trigger a segment flush; live callers can
   * ignore it to preserve real-time playback.
   */
  feedFrame(
    frame: FrameInput,
    cameraId: string,
    onDetection: (result: FrameAnalysisResult) => void,
    options?: FrameAnalyzerOptions,
  ): Promise<void> {
    const policy = options?.policy ?? "latest_only";
    const state = this.getState(cameraId);

    if (policy === "latest_only" && state.busy) {
      state.dropped += 1;
      options?.onDrop?.({
        camera_id: cameraId,
        frame_timestamp: frame.timestamp,
        dropped_total: state.dropped,
        reason: "camera_busy",
      });
      return Promise.resolve();
    }

    if (policy === "lossless") {
      const task = state.chain.then(() => this.detectAndNotify(frame, cameraId, onDetection));
      state.chain = task.catch(() => undefined);
      return task;
    }

    state.busy = true;
    return this.detectAndNotify(frame, cameraId, onDetection)
      .finally(() => {
        state.busy = false;
      });
  }

  private getState(cameraId: string): CameraState {
    let state = this.states.get(cameraId);
    if (!state) {
      state = { busy: false, chain: Promise.resolve(), dropped: 0 };
      this.states.set(cameraId, state);
    }
    return state;
  }

  private async detectAndNotify(
    frame: FrameInput,
    cameraId: string,
    onDetection: (result: FrameAnalysisResult) => void,
  ): Promise<void> {
    try {
      onDetection(await this.runDetection(frame, cameraId));
    } catch {
      onDetection({ camera_id: cameraId, frame_timestamp: frame.timestamp, detections: [] });
    }
  }

  private async runDetection(frame: FrameInput, cameraId: string): Promise<FrameAnalysisResult> {
    const detector = this.router.getDetector("general-detection");
    if (!detector) {
      return { camera_id: cameraId, frame_timestamp: frame.timestamp, detections: [] };
    }

    const imageBuffer = Buffer.from(frame.data, "base64");
    const output = await detector.detect({ imageBuffer, width: frame.width, height: frame.height });

    return {
      camera_id: cameraId,
      frame_timestamp: frame.timestamp,
      detections: output.boxes.map((b) => ({
        label: b.class_name ?? `class_${b.class_id}`,
        confidence: b.confidence,
        bbox: { x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2 },
      })),
    };
  }
}
