import { describe, expect, it } from "vitest";
import {
  buildCandidateQueries,
  buildCandidateQueryHints,
  extractKeywords,
  normalizeQuestionForRetrieval,
  rewriteMemorySearchQueryForSemanticSearch,
} from "../eval/benchmark/pipeline/agent-qa-plan.js";

describe("Agent-QA plan helpers (simple-path retrieval)", () => {
  it("rewrites boolean-style retrieval queries into semantic search phrases", () => {
    expect(rewriteMemorySearchQueryForSemanticSearch(
      '"top scorer" OR "leading scorer" OR "game-high" AND points AND (number OR No.)',
    )).toBe("top scorer leading game-high points number No.");
    expect(rewriteMemorySearchQueryForSemanticSearch(
      "Bitcoin is not suited as a means of payment",
    )).toBe("Bitcoin is not suited as a means of payment");
    expect(rewriteMemorySearchQueryForSemanticSearch(
      "ALL WORK AND NO PLAY MAKES HOLMES A DULL BOY",
    )).toBe("ALL WORK AND NO PLAY MAKES HOLMES A DULL BOY");
  });

  it("builds candidate queries that bind question focus to option facts", () => {
    const queries = buildCandidateQueries({
      id: "hippo_like",
      type: "mcq",
      question: "What is the main character doing visually when they talk about the benefits of socializing?",
      options: [
        "Walking through a park with cherry blossom trees",
        "Sitting at a cafe with a steaming cup of coffee",
        "Lying in bed covered with white sheets",
        "Standing in front of a subway map",
      ],
    }, 4);

    expect(queries).toHaveLength(4);
    expect(queries[2]).toContain("socializing");
    expect(queries[2]).toContain("lying");
    expect(queries[2]).toContain("white sheets");
    expect(queries[2]).toContain("speech");
    expect(queries[2]).toContain("visible");
  });

  it("preserves ordered candidate variants even when options share the same item words", () => {
    const hints = buildCandidateQueryHints({
      id: "order_variants",
      type: "mcq",
      question: "In which order are the following poses introduced? (a) Reclining butterfly pose. (b) Downward facing dog. (c) Camel pose. (d) Seated chair twist.",
      options: [
        "(b)(d)(a)(c).",
        "(d)(b)(c)(a).",
        "(c)(a)(d)(b).",
        "(b)(d)(c)(a).",
      ],
    }, 4);

    expect(hints.map(hint => hint.letter)).toEqual(["A", "B", "C", "D"]);
    expect(new Set(hints.map(hint => hint.query)).size).toBe(4);
    expect(hints[0]?.query).toContain("option order b d a c");
    expect(hints[3]?.query).toContain("option order b d c a");
  });

  it("keeps action-object terms and common speech synonyms in candidate queries", () => {
    const queries = buildCandidateQueries({
      id: "hippo_segment_action",
      type: "mcq",
      question: "What did the main character mention about the ongoing action during the segment?",
      options: [
        "Someone was repairing his car",
        "He was taking pictures of a car",
        "He was listening to a radio broadcast",
        "People were talking about the weather",
      ],
    }, 4);

    expect(queries[1]).toContain("taking");
    expect(queries[1]).toContain("photo");
    expect(queries[1]).toContain("car");
    expect(queries[2]).toContain("listen");
    expect(queries[3]).toContain("talk");
  });

  it("strips benchmark MCQ boilerplate before normalizing the question for retrieval", () => {
    const wrapped = [
      "Select the best answer to the following multiple-choice question based on the video and the subtitles. Respond with only the letter (A, B, C, or D) of the correct option.",
      "According to the video, why did the scientist mention the way a star explodes?",
      "Answer with the option's letter from the given choices directly.",
    ].join("\n");
    const cleaned = normalizeQuestionForRetrieval(wrapped);
    expect(cleaned).toBe("According to the video, why did the scientist mention the way a star explodes?");
    expect(cleaned).not.toContain("Select the best answer");
    expect(cleaned).not.toContain("letter");
  });

  it("expands product-relevant keyword synonyms without adding benchmark-specific logic", () => {
    expect(extractKeywords("favorite online recommendation from friends")).toEqual(expect.arrayContaining([
      "favorite",
      "favourite",
      "comments",
      "viewer",
      "viewers",
      "recommend",
      "suggested",
    ]));
  });
});
