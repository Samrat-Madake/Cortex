// packages/percept/src/notification-resolver.ts
//
// Deterministic notification logic based on structured Perception output.
// VLM does scene analysis; this module decides what to notify.

import type { VlmOutput, AnalyzerResult, ReIdOutput } from "./types.js";
import type { WorkingMemoryState } from "./types.js";

export type NotifyPolicy = "always" | "smart" | "security_only";

/** A resolved notification to send to the user via OpenClaw agent. */
export interface Notification {
  type: "summary" | "alert" | "identify" | "admin_command";
  message: string;
  /** Entity IDs involved in this notification (from ReID). */
  entity_ids?: string[];
}

/** Minimum seconds between summary notifications in "smart" mode. */
const SMART_SUMMARY_COOLDOWN_SEC = 120;

/** Options that control notification behavior beyond VLM output. */
export interface NotifyOptions {
  /** Per-camera notification policy. Default: "smart". */
  policy?: NotifyPolicy;
  /** True only for the very first segment since watch started (not per-event). */
  isFirstWatchSegment?: boolean;
  /** Unix timestamp (ms) of the last summary notification sent. Used for cooldown. */
  lastSummaryTimestamp?: number;
  /** Current time in ms (for testing). Defaults to Date.now(). */
  nowMs?: number;
}

/**
 * Extract a semantic fingerprint from VLM output for change detection.
 * Compares target types, appearances, and behaviors — ignores phrasing differences.
 */
export function extractSceneFingerprint(vlmData: VlmOutput): string {
  // Only compare type + appearance (not behavior) so that the same person
  // sitting still with different micro-actions deduplicates correctly.
  const targets = vlmData.main_targets
    .map((t) => `${t.type}:${t.appearance}`)
    .sort()
    .join("|");
  return `risk=${vlmData.security_risk};targets=${targets}`;
}

/**
 * Resolves notifications from structured Perception output.
 *
 * Decision logic (modulated by NotifyPolicy):
 * 1. security_risk=true → alert (all policies except dedup)
 * 2. ReID + unknown person → identify request (all policies except security_only)
 * 3. First segment of a watch session → always emit summary (regardless of policy)
 * 4. Summary — policy-dependent:
 *    - "always": any non-static segment with persons → summary (fingerprint dedup)
 *    - "smart": VLM notify_user=true + persons → summary (fingerprint dedup)
 *    - "security_only": no summaries
 *
 * Working memory dedup: skips notifications already sent in this event.
 */
export function resolveNotifications(
  vlmData: VlmOutput | null,
  analyzerResults: AnalyzerResult[],
  workingMemoryState: WorkingMemoryState,
  options?: NotifyOptions,
): Notification[] {
  if (!vlmData) return [];
  if (vlmData.is_static_scene) return [];

  const policy = options?.policy ?? "smart";
  // isFirstSegment removed — only isFirstWatchSegment matters for unconditional push
  const notifications: Notification[] = [];
  const recentNotifs = workingMemoryState.recent_notifications;
  const hasPerson = vlmData.main_targets.some((t) => t.type === "person");

  // ── 1. Security risk → alert (all policies, dedup by content) ──
  if (vlmData.security_risk) {
    const msg = vlmData.security_reason ?? vlmData.summary;
    const alreadySent = recentNotifs.some((n) => n.includes("[alert]") && n.includes(msg));
    if (!alreadySent) {
      notifications.push({ type: "alert", message: msg });
    }
  }

  // security_only: skip everything below
  if (policy === "security_only") return notifications;

  // ── 2. ReID + unknown person → identify request ──
  const reidResult = analyzerResults.find((r) => r.analyzer === "reid");
  const allEntityIds = reidResult?.available && reidResult.data
    ? (reidResult.data as ReIdOutput).matches.map(m => m.entity_id).filter(Boolean)
    : [];
  if (reidResult?.available && reidResult.data) {
    const reidData = reidResult.data as ReIdOutput;
    const unknowns = reidData.matches.filter(
      (m) => !m.entity_id || m.entity_id.startsWith("unknown"),
    );
    if (unknowns.length > 0 && !recentNotifs.some((n) => n.includes("[identify]"))) {
      const personTargets = vlmData.main_targets
        .filter((t) => t.type === "person")
        .map((t) => t.appearance)
        .join("; ");
      notifications.push({
        type: "identify",
        message: `Unknown person detected: ${personTargets || "no description available"}`,
        entity_ids: unknowns.map(m => m.entity_id).filter((id): id is string => Boolean(id)),
      });
    }
  }

  // Cooldown: enforce minimum interval for non-VLM-requested summaries
  if (options?.lastSummaryTimestamp != null) {
    const now = options.nowMs ?? Date.now();
    const elapsed = (now - options.lastSummaryTimestamp) / 1000;
    if (elapsed < SMART_SUMMARY_COOLDOWN_SEC) return notifications;
  }

  // ── 4. First segment of new watch session → send summary ──
  const isFirstWatchSegment = options?.isFirstWatchSegment ?? false;
  if (isFirstWatchSegment && hasPerson) {
    notifications.push({ type: "summary", message: vlmData.summary });
    return notifications;
  }

  // ── 5. VLM explicitly requests notification → bypass cooldown ──
  // Skip if alert/identify already sent or pending (avoid double notification)
  const hasRecentAlert = recentNotifs.some((n) => n.includes("[alert]") || n.includes("[identify]"));
  if (vlmData.notify_user && notifications.length === 0 && !hasRecentAlert) {
    const fingerprint = extractSceneFingerprint(vlmData);
    const lastFingerprint = recentNotifs
      .filter((n) => n.startsWith("[summary:fp]"))
      .at(-1)
      ?.slice("[summary:fp]".length) ?? "";
    if (fingerprint !== lastFingerprint) {
      notifications.push({ type: "summary", message: vlmData.summary });
      return notifications;
    }
  }

  // ── 6. "always" policy → push if person present (subject to cooldown) ──
  const hasHighPriority = notifications.length > 0
    || recentNotifs.some((n) => n.includes("[alert]") || n.includes("[identify]"));

  const shouldSummarize = policy === "always";

  if (!hasHighPriority && shouldSummarize) {
    const fingerprint = extractSceneFingerprint(vlmData);
    const lastFingerprint = recentNotifs
      .filter((n) => n.startsWith("[summary:fp]"))
      .at(-1)
      ?.slice("[summary:fp]".length) ?? "";

    if (fingerprint !== lastFingerprint) {
      notifications.push({ type: "summary", message: vlmData.summary });
    }
  }

  return notifications;
}
