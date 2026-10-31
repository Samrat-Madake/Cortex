import { monitorBus, writeStderr, type PerceptionResult, type Segment } from "@reflectworld/shared";
import { extractSceneFingerprint, resolveNotifications } from "../notification-resolver.js";
import type { AnalyzerResult, VlmOutput } from "../types.js";
import type { WorkingMemoryManager } from "../working-memory.js";
import { applyMemoryHistoryTiming, type MemoryHistoryTiming } from "./observability.js";
import type { PipelineDeps, PipelineRuntimeState, VlmMeta } from "./types.js";

async function writeMemoryHistory(input: {
  storePerception: (result: PerceptionResult, segment: Segment) => Promise<void>;
  result: PerceptionResult;
  segment: Segment;
  startedAt: number;
  onFinalError?: (message: string) => void;
}): Promise<MemoryHistoryTiming> {
  const { storePerception, result, segment, startedAt, onFinalError } = input;
  try {
    await storePerception(result, segment);
    const storedAt = Date.now();
    const latencyMs = storedAt - startedAt;
    if (result._archive?.memory_write) {
      result._archive.memory_write = {
        ...result._archive.memory_write,
        status: "ok",
        latency_ms: latencyMs,
      };
    }
    return { completedAt: storedAt, latencyMs };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    writeStderr(`[perception] Memory storage failed: ${msg}`);
    const completedAt = Date.now();
    const latencyMs = completedAt - startedAt;
    if (result._archive?.memory_write) {
      result._archive.memory_write = {
        ...result._archive.memory_write,
        status: "error",
        latency_ms: latencyMs,
        error: msg,
      };
    }
    onFinalError?.(msg);
    return { completedAt, latencyMs };
  }
}

export async function runPipelinePostprocess(input: {
  deps: PipelineDeps;
  workingMemory: WorkingMemoryManager;
  runtimeState: PipelineRuntimeState;
  segment: Segment;
  result: PerceptionResult;
  analyzerResults: AnalyzerResult[];
  analyzersSkipped: string[];
  segmentKeyframePaths: string[];
  mySegmentCount: number;
  myRecentNotifs: string[];
  strategy: { level: number; vlm_model: string };
  vlmOutput: VlmOutput | null;
  vlmResult?: AnalyzerResult;
  localStaticScene: boolean;
}): Promise<{
  memoryHistoryTiming?: MemoryHistoryTiming;
  memoryHistoryBlockingMs?: number;
  notificationSentAt?: number;
}> {
  const {
    deps,
    workingMemory,
    runtimeState,
    segment,
    result,
    analyzerResults,
    analyzersSkipped,
    segmentKeyframePaths,
    mySegmentCount,
    myRecentNotifs,
    strategy,
    vlmOutput,
    vlmResult,
    localStaticScene,
  } = input;
  const pp = deps.postProcessor;
  const memory = deps.memory;
  let memoryHistoryTiming: MemoryHistoryTiming | undefined;
  let memoryHistoryBlockingMs: number | undefined;
  let notificationSentAt: number | undefined;

  if (pp || memory?.storePerception) {
    const wmState = { ...workingMemory.getState(segment.camera_id), segment_count: mySegmentCount, recent_notifications: myRecentNotifs };
    const notifyPolicy = pp?.getNotifyPolicy?.(segment.camera_id) ?? "smart";
    // Only true for the very first segment since this camera started watching
    // (not per-event - new events within the same watch do not trigger)
    const isFirstWatchSegment = !runtimeState.firstWatchDone.has(segment.camera_id);
    if (isFirstWatchSegment) runtimeState.firstWatchDone.add(segment.camera_id);

    if (vlmOutput) {
      const { is_static_scene, notify_user, security_risk } = vlmOutput;
      const personCount = vlmOutput.main_targets.filter(t => t.type === "person").length;
      writeStderr(`[perception] ${segment.camera_id} seg#${mySegmentCount} | L${strategy.level} frames=${segment.frames.length} policy=${notifyPolicy} notify=${notify_user} static=${is_static_scene} risk=${security_risk} persons=${personCount}`);
    }

    const notifications = resolveNotifications(vlmOutput, analyzerResults, wmState, {
      policy: notifyPolicy,
      isFirstWatchSegment,
      lastSummaryTimestamp: wmState.last_summary_timestamp,
    });

    for (const n of notifications) {
      if (n.type === "summary" && vlmOutput) {
        workingMemory.addRecentNotification(segment.camera_id, `[summary:fp]${extractSceneFingerprint(vlmOutput)}`);
        workingMemory.getState(segment.camera_id).last_summary_timestamp = Date.now();
      } else {
        workingMemory.addRecentNotification(segment.camera_id, `[${n.type}] ${n.message}`);
      }
    }

    monitorBus.publish("perception:notification_resolved", {
      segment_id: segment.segment_id,
      notification_count: notifications.length,
      types: notifications.map(n => n.type),
      policy: notifyPolicy,
    }, segment.camera_id);

    if (vlmOutput && memory?.storePerception) {
      const memoryWriteStartedAt = Date.now();
      const memoryHistoryWrite = writeMemoryHistory({
        storePerception: memory.storePerception,
        result,
        segment,
        startedAt: memoryWriteStartedAt,
        onFinalError: (msg) => pp?.onPipelineError?.(segment.segment_id, segment.camera_id, "memory_write", msg),
      });
      if (deps.memoryHistoryMode === "strict") {
        const memoryWaitStartedAt = Date.now();
        memoryHistoryTiming = await memoryHistoryWrite;
        memoryHistoryBlockingMs = Date.now() - memoryWaitStartedAt;
      } else {
        memoryHistoryBlockingMs = 0;
        void memoryHistoryWrite.then((timing) => {
          const publishTiming = (): void => {
            if (!result._trace) return;
            applyMemoryHistoryTiming(result._trace, timing, 0);
            monitorBus.publish("system:pipeline_trace", result._trace as unknown as Record<string, unknown>, segment.camera_id);
          };
          if (result._trace) {
            publishTiming();
          } else {
            queueMicrotask(publishTiming);
          }
        });
      }
    } else {
      analyzersSkipped.push("memory:no_vlm_result");
    }

    if (pp && notifications.length > 0) {
      const NOTIFY_TIMEOUT_MS = 10_000;
      Promise.race([
        pp.sendNotifications(notifications, segment.camera_id, segmentKeyframePaths[0]),
        new Promise<void>((_, reject) => setTimeout(() => reject(new Error("notification timeout")), NOTIFY_TIMEOUT_MS)),
      ])
        .then(() => { notificationSentAt = Date.now(); })
        .catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          writeStderr(`[perception] Notification delivery failed: ${msg}`);
          pp?.onPipelineError?.(segment.segment_id, segment.camera_id, "notification", msg);
        });
    }

    if (pp?.onPipelineComplete) {
      const vlmMeta: VlmMeta | null = vlmOutput ? {
        notify_user: vlmOutput.notify_user,
        is_static_scene: vlmOutput.is_static_scene,
        best_frame_index: vlmOutput.best_frame_index,
        vlm_model: strategy.vlm_model,
        vlm_latency_ms: vlmResult?.latency_ms ?? 0,
      } : localStaticScene ? {
        notify_user: false,
        is_static_scene: true,
        vlm_model: "local-idle-skip",
        vlm_latency_ms: 0,
      } : null;
      pp.onPipelineComplete(result, segment, {
        vlm: vlmMeta,
        notifications,
        policy: notifyPolicy,
      });
    }
  }

  return { memoryHistoryTiming, memoryHistoryBlockingMs, notificationSentAt };
}
