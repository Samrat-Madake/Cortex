// packages/percept/src/anonymous-matcher.ts
// VLM anonymous subject matching: rule enforcement and context management.

import type { AnonymousSubjectContext } from "./types.js";
import { ANONYMOUS_MATCH_CONFIDENCE_THRESHOLD } from "./thresholds.js";

/** VLM output for a single non-face target's anonymous matching decision. */
export interface AnonymousMatchDecision {
  /** Keyframe-scoped label from Set-of-Mark annotation, e.g. "kf0_P1". */
  keyframe_label: string;
  /** Detection class. */
  class_name: string;
  /** VLM-generated appearance description. */
  appearance: string;
  /** VLM-generated behavior description. */
  behavior?: string;
  /** ID of matched historical anonymous subject, or null/undefined if new. */
  matched_anonymous_subject_id?: string | null;
  /** VLM confidence in the match (required when matched_anonymous_subject_id is non-null). */
  match_confidence?: number;
}

export interface ValidatedMatch {
  keyframe_label: string;
  class_name: string;
  appearance: string;
  behavior?: string;
  /** null = new anonymous subject; string = matched existing. */
  anonymous_subject_id: string | null;
  /** Whether this is a new anonymous subject to be created. */
  is_new: boolean;
  match_confidence?: number;
  rejection_reason?: string;
}

/**
 * Validate VLM anonymous match decisions against hard rules.
 *
 * Rules (enforced in code, not dependent on VLM compliance):
 * 1. matched_anonymous_subject_id non-null → match_confidence must exist and >= threshold
 * 2. class_name must match historical anonymous subject's class_name
 * 3. Same keyframe_label cannot match multiple anonymous subjects
 * 4. Same anonymous subject can only be matched by one current target per segment
 * 5. Conflicts → reject match, create new anonymous
 */
export function validateAnonymousMatches(
  decisions: AnonymousMatchDecision[],
  activeAnonymous: AnonymousSubjectContext[],
  confidenceThreshold: number = ANONYMOUS_MATCH_CONFIDENCE_THRESHOLD,
): ValidatedMatch[] {
  const activeByid = new Map(activeAnonymous.map((s) => [s.anonymous_subject_id, s]));

  // Track which anonymous subjects have been claimed (rule 4: one-to-one)
  const claimedAnonymous = new Map<string, { label: string; confidence: number }>();
  // Track which keyframe labels have already declared a match (rule 3: one label → one anonymous)
  const claimedLabels = new Set<string>();

  const results: ValidatedMatch[] = [];

  for (const decision of decisions) {
    const matchId = decision.matched_anonymous_subject_id;

    // No match declared → new anonymous
    if (!matchId) {
      results.push({
        keyframe_label: decision.keyframe_label,
        class_name: decision.class_name,
        appearance: decision.appearance,
        behavior: decision.behavior,
        anonymous_subject_id: null,
        is_new: true,
      });
      continue;
    }

    // Rule 1: confidence threshold
    const confidence = decision.match_confidence ?? 0;
    if (confidence < confidenceThreshold) {
      results.push({
        keyframe_label: decision.keyframe_label,
        class_name: decision.class_name,
        appearance: decision.appearance,
        behavior: decision.behavior,
        anonymous_subject_id: null,
        is_new: true,
        rejection_reason: `confidence ${confidence.toFixed(2)} < threshold ${confidenceThreshold}`,
      });
      continue;
    }

    // Rule 3: same keyframe_label can only match one anonymous subject
    if (claimedLabels.has(decision.keyframe_label)) {
      results.push({
        keyframe_label: decision.keyframe_label,
        class_name: decision.class_name,
        appearance: decision.appearance,
        behavior: decision.behavior,
        anonymous_subject_id: null,
        is_new: true,
        rejection_reason: `keyframe_label ${decision.keyframe_label} already matched another anonymous subject`,
      });
      continue;
    }

    // Rule 2: class_name must match
    const historical = activeByid.get(matchId);
    if (!historical) {
      results.push({
        keyframe_label: decision.keyframe_label,
        class_name: decision.class_name,
        appearance: decision.appearance,
        behavior: decision.behavior,
        anonymous_subject_id: null,
        is_new: true,
        rejection_reason: `anonymous subject ${matchId} not found in active list`,
      });
      continue;
    }
    if (historical.class_name !== decision.class_name) {
      results.push({
        keyframe_label: decision.keyframe_label,
        class_name: decision.class_name,
        appearance: decision.appearance,
        behavior: decision.behavior,
        anonymous_subject_id: null,
        is_new: true,
        rejection_reason: `class mismatch: ${decision.class_name} vs ${historical.class_name}`,
      });
      continue;
    }

    // Rule 4: one anonymous subject per segment max one match
    const existing = claimedAnonymous.get(matchId);
    if (existing) {
      // Keep the higher-confidence match, reject the other
      if (confidence > existing.confidence) {
        // Retroactively reject the previous claim
        const prev = results.find((r) => r.keyframe_label === existing.label && r.anonymous_subject_id === matchId);
        if (prev) {
          prev.anonymous_subject_id = null;
          prev.is_new = true;
          prev.rejection_reason = `superseded by higher-confidence match from ${decision.keyframe_label}`;
        }
        claimedAnonymous.set(matchId, { label: decision.keyframe_label, confidence });
        claimedLabels.add(decision.keyframe_label);
        results.push({
          keyframe_label: decision.keyframe_label,
          class_name: decision.class_name,
          appearance: decision.appearance,
          behavior: decision.behavior,
          anonymous_subject_id: matchId,
          is_new: false,
          match_confidence: confidence,
        });
      } else {
        results.push({
          keyframe_label: decision.keyframe_label,
          class_name: decision.class_name,
          appearance: decision.appearance,
          behavior: decision.behavior,
          anonymous_subject_id: null,
          is_new: true,
          rejection_reason: `anonymous ${matchId} already claimed by ${existing.label} with higher confidence`,
        });
      }
      continue;
    }

    // Match accepted
    claimedAnonymous.set(matchId, { label: decision.keyframe_label, confidence });
    claimedLabels.add(decision.keyframe_label);
    results.push({
      keyframe_label: decision.keyframe_label,
      class_name: decision.class_name,
      appearance: decision.appearance,
      behavior: decision.behavior,
      anonymous_subject_id: matchId,
      is_new: false,
      match_confidence: confidence,
    });
  }

  return results;
}

/** Generate a stable anonymous subject ID. */
export function generateAnonymousId(): string {
  return `anon_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}
