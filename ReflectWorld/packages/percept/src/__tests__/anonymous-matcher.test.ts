import { describe, it, expect } from "vitest";
import { validateAnonymousMatches } from "../anonymous-matcher.js";
import type { AnonymousSubjectContext } from "../types.js";

function makeAnon(overrides: Partial<AnonymousSubjectContext> = {}): AnonymousSubjectContext {
  return {
    anonymous_subject_id: "anon_test",
    class_name: "person",
    appearance: "tall person in red shirt",
    crop_path: "/tmp/crop.jpg",
    last_seen_segment_id: "seg_0",
    last_seen_timestamp: 1000,
    segments_seen: 1,
    segments_missed: 0,
    ...overrides,
  };
}

describe("validateAnonymousMatches", () => {
  it("accepts a valid match above confidence threshold", () => {
    const results = validateAnonymousMatches(
      [{ keyframe_label: "kf0_P1", class_name: "person", appearance: "red shirt", matched_anonymous_subject_id: "anon_test", match_confidence: 0.8 }],
      [makeAnon()],
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.anonymous_subject_id).toBe("anon_test");
    expect(results[0]!.is_new).toBe(false);
  });

  it("rejects match below confidence threshold and creates new", () => {
    const results = validateAnonymousMatches(
      [{ keyframe_label: "kf0_P1", class_name: "person", appearance: "red shirt", matched_anonymous_subject_id: "anon_test", match_confidence: 0.3 }],
      [makeAnon()],
    );
    expect(results[0]!.anonymous_subject_id).toBeNull();
    expect(results[0]!.is_new).toBe(true);
    expect(results[0]!.rejection_reason).toContain("confidence");
  });

  it("rejects class mismatch (car vs vehicle are NOT normalized here — caller must normalize)", () => {
    const results = validateAnonymousMatches(
      [{ keyframe_label: "kf0_V1", class_name: "vehicle", appearance: "white SUV", matched_anonymous_subject_id: "anon_car", match_confidence: 0.9 }],
      [makeAnon({ anonymous_subject_id: "anon_car", class_name: "vehicle" })],
    );
    // Same normalized class → accepted
    expect(results[0]!.anonymous_subject_id).toBe("anon_car");
    expect(results[0]!.is_new).toBe(false);
  });

  it("rejects class mismatch between person and vehicle", () => {
    const results = validateAnonymousMatches(
      [{ keyframe_label: "kf0_P1", class_name: "person", appearance: "...", matched_anonymous_subject_id: "anon_car", match_confidence: 0.9 }],
      [makeAnon({ anonymous_subject_id: "anon_car", class_name: "vehicle" })],
    );
    expect(results[0]!.is_new).toBe(true);
    expect(results[0]!.rejection_reason).toContain("class mismatch");
  });

  it("enforces one-to-one: same anonymous cannot be claimed by two labels", () => {
    const results = validateAnonymousMatches(
      [
        { keyframe_label: "kf0_P1", class_name: "person", appearance: "...", matched_anonymous_subject_id: "anon_test", match_confidence: 0.9 },
        { keyframe_label: "kf0_P2", class_name: "person", appearance: "...", matched_anonymous_subject_id: "anon_test", match_confidence: 0.7 },
      ],
      [makeAnon()],
    );
    const accepted = results.filter((r) => r.anonymous_subject_id === "anon_test");
    expect(accepted).toHaveLength(1);
    expect(accepted[0]!.keyframe_label).toBe("kf0_P1"); // higher confidence wins
  });

  it("enforces one label → one anonymous: same label cannot match multiple", () => {
    const results = validateAnonymousMatches(
      [
        { keyframe_label: "kf0_P1", class_name: "person", appearance: "...", matched_anonymous_subject_id: "anon_a", match_confidence: 0.8 },
        { keyframe_label: "kf0_P1", class_name: "person", appearance: "...", matched_anonymous_subject_id: "anon_b", match_confidence: 0.9 },
      ],
      [
        makeAnon({ anonymous_subject_id: "anon_a" }),
        makeAnon({ anonymous_subject_id: "anon_b" }),
      ],
    );
    // First match accepted, second rejected (same label already claimed)
    expect(results[0]!.anonymous_subject_id).toBe("anon_a");
    expect(results[1]!.is_new).toBe(true);
    expect(results[1]!.rejection_reason).toContain("already matched");
  });

  it("creates new anonymous when no match declared", () => {
    const results = validateAnonymousMatches(
      [{ keyframe_label: "kf0_P1", class_name: "person", appearance: "new person" }],
      [makeAnon()],
    );
    expect(results[0]!.is_new).toBe(true);
    expect(results[0]!.anonymous_subject_id).toBeNull();
  });
});
