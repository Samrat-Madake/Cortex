import type { PerceptionResult, Segment } from "@cortex/shared";
import type {
  VisionControllerConfig,
  FramePolicyOutput,
  SegmentPolicyOutput,
  CameraState,
  FrameLevelSignals,
  SegmentPolicyState,
  SegmentPolicyOverrideAction,
} from "./types.js";
import type { Rule, RuleAction, SegmentSignals, TriggerCondition } from "../vc-types/types.js";
import type { FrameDetectionInput, MotionHint, VadHint } from "./frame-signal-extractor.js";
import { extractFrameSignals } from "./frame-signal-extractor.js";
import { matchFrameCondition, matchCondition, isFrameLevelRule } from "./rule-matcher.js";
import { extractSignals } from "../vc-types/signal-extractor.js";

/** Absolute maximum segment policy hold duration (5 minutes). */
const SEGMENT_POLICY_ABSOLUTE_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * VisionController — adaptive perception strategy engine with two entry points:
 *
 * - evaluateFrame(): frame policy using detection + motion signals.
 *   Uses media timestamps for hold/cooldown (NOT Date.now()).
 *
 * - evaluateSegment(): segment policy after VLM/ReID, plus Agent consultation.
 *   Manages segment policy override state with exit conditions and absolute timeout.
 *
 * All state is per-camera to prevent cross-camera interference.
 */
export class VisionController {
  private config: VisionControllerConfig;
  private cameraStates = new Map<string, CameraState>();

  /** Rules whose trigger conditions are fully evaluable from frame-level signals. */
  private framePolicyRules: Rule[] = [];
  /** Rules that require segment/VLM signals — not frame-evaluable. */
  private segmentPolicyRules: Rule[] = [];

  constructor(config: VisionControllerConfig) {
    this.config = { ...config, rules: [...config.rules] };
    this.classifyRules();
  }

  /** Split rules into frame-level vs segment-only buckets. */
  private classifyRules(): void {
    this.framePolicyRules = [];
    this.segmentPolicyRules = [];
    for (const rule of this.config.rules) {
      if (isFrameLevelRule(rule.trigger)) {
        this.framePolicyRules.push(rule);
      } else {
        this.segmentPolicyRules.push(rule);
      }
    }
  }

  /** Get or create per-camera state. */
  private getState(cameraId: string): CameraState {
    let state = this.cameraStates.get(cameraId);
    if (!state) {
      state = {
        prevFrameSignals: null,
        ruleCooldowns: new Map(),
        framePolicyHoldUntil: 0,
        lastFramePolicyAction: null,
        prevSegmentSignals: null,
        segmentPolicy: {
          override: null,
          exitCondition: null,
          activatedAt: 0,
          absoluteMaxHoldMs: SEGMENT_POLICY_ABSOLUTE_TIMEOUT_MS,
        },
        lastAgentConsultAt: 0,
        eventsSinceConsult: 0,
        lastEventId: undefined,
      };
      this.cameraStates.set(cameraId, state);
    }
    return state;
  }

  // ── Frame policy: frame-level evaluation ──

  /**
   * Evaluate frame-level rules against detection + motion signals.
   * Called per-frame BEFORE VLM, so it can gate VLM invocation.
   *
   * @param cameraId       Camera identifier.
   * @param detections     Detection results from this frame (YOLO26m / RetinaFace).
   * @param motionHint     Current motion state from MotionFilter.
   * @param frameTimestamp  Media timestamp of this frame (ms). Used for hold/cooldown.
   */
  evaluateFrame(
    cameraId: string,
    detections: FrameDetectionInput[],
    motionHint: MotionHint | undefined,
    frameTimestamp: number,
    vadHint?: VadHint,
  ): FramePolicyOutput {
    if (!this.config.enabled) {
      return {
        firedRules: [],
        firedRuleDetails: [],
        action: { ...this.config.baseline },
        signals: extractFrameSignals(detections, motionHint, frameTimestamp, vadHint),
      };
    }

    const state = this.getState(cameraId);
    const signals = extractFrameSignals(detections, motionHint, frameTimestamp, vadHint);
    state.prevFrameSignals = signals;

    // Scan frame-level rules, first-write-wins merge
    const merged: FramePolicyOutput["action"] = {};
    const firedRules: string[] = [];
    const firedRuleDetails: FramePolicyOutput["firedRuleDetails"] = [];

    for (const rule of this.framePolicyRules) {
      // Cooldown check using media time (only applies after first fire)
      const lastFired = state.ruleCooldowns.get(rule.name);
      if (lastFired !== undefined && rule.cooldown_ms && (frameTimestamp - lastFired) < rule.cooldown_ms) continue;

      if (matchFrameCondition(rule.trigger, signals)) {
        // First-write-wins merge
        for (const [key, val] of Object.entries(rule.action)) {
          if ((merged as Record<string, unknown>)[key] === undefined) {
            (merged as Record<string, unknown>)[key] = val;
          }
        }
        firedRules.push(rule.name);
        firedRuleDetails.push({
          name: rule.name,
          trigger: rule.trigger,
          action: rule.action,
        });
        state.ruleCooldowns.set(rule.name, frameTimestamp);
      }
    }

    // Determine action with hold semantics
    let action: FramePolicyOutput["action"];

    if (firedRules.length > 0) {
      // Rules fired: use merged result + refresh hold timer
      action = merged;
      state.lastFramePolicyAction = { ...merged };
      const maxHold = Math.max(
        ...this.framePolicyRules
          .filter((r) => firedRules.includes(r.name))
          .map((r) => r.hold_ms ?? 10_000),
      );
      state.framePolicyHoldUntil = frameTimestamp + maxHold;
    } else if (state.lastFramePolicyAction && frameTimestamp < state.framePolicyHoldUntil) {
      // Hold period active — keep previous escalated action
      action = state.lastFramePolicyAction;
    } else {
      // Hold expired — revert to baseline
      action = { ...this.config.baseline };
      state.lastFramePolicyAction = null;
    }

    // System-level guarantee: voice content must never be silently dropped.
    if (signals.has_voice && action.skip_vlm === true) {
      action = { ...action, skip_vlm: false };
    }

    return { firedRules, firedRuleDetails, action, signals };
  }

  // ── Segment policy: segment-level evaluation ──

  /**
   * Evaluate segment-level rules after VLM/ReID processing.
   * Manages segment policy override state, exit conditions, and Agent consultation.
   *
   * @param result  PerceptionResult from the analysis pipeline.
   * @param segment Source Segment.
   */
  evaluateSegment(
    result: PerceptionResult,
    segment: Segment,
  ): SegmentPolicyOutput {
    const cameraId = segment.camera_id;

    if (!this.config.enabled) {
      return {
        firedRules: [],
        firedRuleDetails: [],
        action: {},
        segmentPolicyCleared: false,
        shouldConsultAgent: false,
      };
    }

    const state = this.getState(cameraId);
    const segmentEndMs = segment.timestamp + Math.round(segment.duration_sec * 1000);
    const signals = extractSignals(result, segment, state.prevSegmentSignals);
    state.prevSegmentSignals = signals;

    // ── Step 1: Check exit condition ──
    let segmentPolicyCleared = false;
    if (state.segmentPolicy.override) {
      const exitMet = this.checkSegmentPolicyExit(state.segmentPolicy, signals, result, segmentEndMs);
      if (exitMet) {
        state.segmentPolicy.override = null;
        state.segmentPolicy.exitCondition = null;
        state.segmentPolicy.activatedAt = 0;
        segmentPolicyCleared = true;
      }
    }

    // ── Step 2: Run segment policy rules ──
    const merged: SegmentPolicyOverrideAction = {};
    const firedRules: string[] = [];
    const firedRuleDetails: SegmentPolicyOutput["firedRuleDetails"] = [];

    for (const rule of this.segmentPolicyRules) {
      const lastFired = state.ruleCooldowns.get(rule.name);
      if (lastFired !== undefined && rule.cooldown_ms && (segmentEndMs - lastFired) < rule.cooldown_ms) continue;

      if (matchCondition(rule.trigger, signals)) {
        for (const [key, val] of Object.entries(rule.action)) {
          if (key === "mode") continue; // Segment policy does not override capture mode.
          if ((merged as Record<string, unknown>)[key] === undefined) {
            (merged as Record<string, unknown>)[key] = val;
          }
        }
        firedRules.push(rule.name);
        firedRuleDetails.push({
          name: rule.name,
          trigger: rule.trigger,
          action: rule.action,
        });
        state.ruleCooldowns.set(rule.name, segmentEndMs);
      }
    }

    // ── Step 3: Update segment policy override state ──
    let action: SegmentPolicyOverrideAction;

    if (firedRules.length > 0) {
      // New rules fired — set/update override
      state.segmentPolicy.override = { ...merged };
      if (state.segmentPolicy.activatedAt === 0) {
        state.segmentPolicy.activatedAt = segmentEndMs;
      }
      action = { ...merged };
    } else if (state.segmentPolicy.override && !segmentPolicyCleared) {
      // No new rules but override still active
      action = { ...state.segmentPolicy.override };
    } else {
      // No override
      action = {};
    }

    // ── Step 4: Check segment_policy for Agent consultation ──
    let shouldConsultAgent = false;
    let consultationContext: SegmentPolicyOutput["consultationContext"];

    if (this.config.segment_policy) {
      const policy = this.config.segment_policy;

      // Track event transitions (event_id change = previous event closed)
      const currentEventId = result.event_id;
      if (currentEventId && currentEventId !== state.lastEventId) {
        state.eventsSinceConsult = (state.eventsSinceConsult ?? 0) + 1;
        state.lastEventId = currentEventId;
      }

      const cooldownMet =
        state.lastAgentConsultAt === 0
        || (segmentEndMs - state.lastAgentConsultAt) >= policy.consultation_cooldown_seconds * 1000;

      if (cooldownMet) {
        // Check event budget: force consultation every N events regardless of triggers
        const eventBudget = policy.consultation_event_budget ?? 0;
        const budgetMet = eventBudget > 0 && (state.eventsSinceConsult ?? 0) >= eventBudget;

        // Check trigger conditions
        let triggerReason: TriggerCondition | undefined;
        for (const trigger of policy.consultation_triggers) {
          if (matchCondition(trigger, signals)) {
            triggerReason = trigger;
            break;
          }
        }

        if (triggerReason || budgetMet) {
          shouldConsultAgent = true;
          consultationContext = {
            camera_id: cameraId,
            signals,
            trigger_reason: triggerReason ?? { type: "periodic_budget", event_budget: eventBudget },
          };
          state.lastAgentConsultAt = segmentEndMs;
          state.eventsSinceConsult = 0;
        }
      }
    }

    return { firedRules, firedRuleDetails, action, segmentPolicyCleared, shouldConsultAgent, consultationContext };
  }

  /**
   * Check whether the segment policy exit condition is met.
   * Conditions: VLM segment_policy_exit_met field, structured matchCondition, or absolute timeout.
   */
  private checkSegmentPolicyExit(
    segmentPolicy: SegmentPolicyState,
    signals: SegmentSignals,
    result: PerceptionResult,
    nowMs: number,
  ): boolean {
    // VLM-driven exit: perception_memory includes segment_policy_exit_met flag
    const pm = result.perception_memory as unknown as Record<string, unknown>;
    if (pm.segment_policy_exit_met === true) return true;

    // Structured exit condition match
    if (segmentPolicy.exitCondition && matchCondition(segmentPolicy.exitCondition, signals)) return true;

    // Absolute timeout
    if (segmentPolicy.activatedAt > 0 && (nowMs - segmentPolicy.activatedAt) >= segmentPolicy.absoluteMaxHoldMs) return true;

    return false;
  }

  // ── Public accessors ──

  /** Set segment policy exit condition (typically called by Agent after consultation). */
  setSegmentPolicyExitCondition(cameraId: string, condition: SegmentPolicyState["exitCondition"]): void {
    const state = this.getState(cameraId);
    state.segmentPolicy.exitCondition = condition;
  }

  /** Get frame policy hold state for a camera (for fps revert decisions). */
  getFramePolicyState(cameraId: string, currentMediaTime?: number): {
    holdActive: boolean;
    holdUntil: number;
    lastAction: FramePolicyOutput["action"] | null;
  } {
    const state = this.cameraStates.get(cameraId);
    if (!state) {
      return { holdActive: false, holdUntil: 0, lastAction: null };
    }
    // If no currentMediaTime provided, assume hold is active when action exists (backward compat)
    const holdActive = state.lastFramePolicyAction !== null && (
      currentMediaTime != null ? currentMediaTime < state.framePolicyHoldUntil : state.framePolicyHoldUntil > 0
    );
    return {
      holdActive,
      holdUntil: state.framePolicyHoldUntil,
      lastAction: state.lastFramePolicyAction,
    };
  }

  /** Get segment policy state for a camera (for VLM prompt injection). */
  getSegmentPolicyState(cameraId: string): SegmentPolicyState {
    const state = this.cameraStates.get(cameraId);
    if (!state) {
      return {
        override: null,
        exitCondition: null,
        activatedAt: 0,
        absoluteMaxHoldMs: SEGMENT_POLICY_ABSOLUTE_TIMEOUT_MS,
      };
    }
    return { ...state.segmentPolicy };
  }

  /** Runtime reconfiguration. Merges partial config into existing. */
  reconfigure(partial: Partial<VisionControllerConfig>): void {
    if (partial.enabled !== undefined) this.config.enabled = partial.enabled;
    if (partial.baseline) this.config.baseline = { ...this.config.baseline, ...partial.baseline };
    if (partial.rules) {
      this.config.rules = [...partial.rules];
      this.classifyRules();
    }
    if (partial.segment_policy) this.config.segment_policy = partial.segment_policy;
  }

  /** Get current config (for status reporting). */
  getConfig(): VisionControllerConfig {
    return this.config;
  }

  /** Full reset for a camera — called on watch stop to prevent state bleed. */
  resetCamera(cameraId: string): void {
    this.cameraStates.delete(cameraId);
  }
}
