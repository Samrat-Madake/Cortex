import type { Segment } from "@reflectworld/shared";
import type { PipelineDeps, PipelineRuntimeState } from "./types.js";

const STATIC_THRESHOLD_FOR_EVENT_SWITCH = 5;
const STATIC_THRESHOLD_FOR_FPS_LOWER = 3;

/** Create a fresh runtime state container. */
export function createPipelineRuntimeState(): PipelineRuntimeState {
  return {
    staticSceneCounters: new Map(),
    firstWatchDone: new Set(),
  };
}

/** Clear runtime state for a specific camera (call on watch stop). */
export function clearCameraRuntimeState(state: PipelineRuntimeState, cameraId: string): void {
  state.staticSceneCounters.delete(cameraId);
  state.firstWatchDone.delete(cameraId);
}

export function emitAdaptiveCaptureHint(input: {
  deps: Pick<PipelineDeps, "postProcessor" | "visionControllerEnabled">;
  runtimeState: PipelineRuntimeState;
  segment: Pick<Segment, "camera_id" | "mode">;
  isStaticScene: boolean;
}): void {
  const { deps, runtimeState, segment, isStaticScene } = input;
  if (!deps.postProcessor?.onCaptureHint || segment.mode !== "stream" || deps.visionControllerEnabled) return;

  const counter = runtimeState.staticSceneCounters.get(segment.camera_id) ?? 0;

  if (isStaticScene) {
    const newCount = counter + 1;
    runtimeState.staticSceneCounters.set(segment.camera_id, newCount);

    if (newCount === STATIC_THRESHOLD_FOR_EVENT_SWITCH) {
      deps.postProcessor.onCaptureHint(segment.camera_id, {
        action: "switch_to_event",
        reason: `${newCount} consecutive static segments — switching to event mode to save resources`,
      });
    } else if (newCount === STATIC_THRESHOLD_FOR_FPS_LOWER) {
      deps.postProcessor.onCaptureHint(segment.camera_id, {
        action: "lower_fps",
        reason: `${newCount} consecutive static segments — reducing fps`,
        suggestedFps: 0.5,
      });
    }
  } else {
    if (counter >= STATIC_THRESHOLD_FOR_FPS_LOWER) {
      deps.postProcessor.onCaptureHint(segment.camera_id, {
        action: "restore",
        reason: "Activity detected after static period — restoring capture params",
      });
    }
    runtimeState.staticSceneCounters.set(segment.camera_id, 0);
  }
}
