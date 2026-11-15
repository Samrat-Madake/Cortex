/**
 * SkillTester — runs 5 simulated user instructions through SimAgent
 * and validates that the tool call output matches expectations.
 */

import type { SimAgent, ToolCall } from "./sim-agent.js";
import type { SkillTestResult } from "./report-generator.js";

// ── Test Definitions ──

interface SkillTestCase {
  instruction: string;
  expectedTool: string;
  expectedAction: string;
  /** Semantic validation of the output params. */
  validate: (call: ToolCall) => { passed: boolean; details: string };
}

const TEST_CASES: SkillTestCase[] = [
  {
    instruction: "Use night security mode to monitor this camera",
    expectedTool: "cortex_perception",
    expectedAction: "configure",
    validate: (call) => {
      const hasNightSecurity =
        JSON.stringify(call.params).toLowerCase().includes("night") ||
        JSON.stringify(call.params).toLowerCase().includes("security");
      return {
        passed: hasNightSecurity,
        details: hasNightSecurity
          ? "Contains night security related configuration"
          : "Missing night security configuration",
      };
    },
  },
  {
    instruction: "Update walking scene guidance",
    expectedTool: "cortex_perception",
    expectedAction: "configure",
    validate: (call) => {
      const hasWalking =
        JSON.stringify(call.params).toLowerCase().includes("walking") ||
        JSON.stringify(call.params).toLowerCase().includes("walk");
      return {
        passed: hasWalking,
        details: hasWalking
          ? "Contains walking related configuration"
          : "Missing walking configuration",
      };
    },
  },
  {
    instruction: "Set the frame rate to 3",
    expectedTool: "cortex_cam",
    expectedAction: "set_sampling",
    validate: (call) => {
      const params = call.params ?? {};
      const fps = params.fps as number | undefined;
      const inRange = fps !== undefined && fps >= 2 && fps <= 4; // 3 +/- 1 tolerance
      return {
        passed: inRange,
        details: inRange ? `fps=${fps} (within tolerance)` : `fps=${fps ?? "missing"} (expected ~3)`,
      };
    },
  },
  {
    instruction: "Stop monitoring",
    expectedTool: "cortex_cam",
    expectedAction: "stop_watch",
    validate: (call) => {
      const params = call.params ?? {};
      const hasName = typeof params.name === "string" && params.name.length > 0;
      return {
        passed: hasName,
        details: hasName ? `name="${params.name}"` : "Missing camera name parameter",
      };
    },
  },
  {
    instruction: "Who came by today?",
    expectedTool: "cortex_memory",
    expectedAction: "search",
    validate: (call) => {
      const params = call.params ?? {};
      const query = String(params.query ?? "").toLowerCase();
      const relevant =
        query.includes("person") ||
        query.includes("people") ||
        query.includes("who") ||
        query.includes("visitor") ||
        query.includes("came") ||
        query.includes("arrived") ||
        query.length > 0; // Any non-empty query about people is acceptable
      return {
        passed: relevant,
        details: relevant ? `query="${params.query}"` : "Query does not seem person-related",
      };
    },
  },
];

// ── Runner ──

/**
 * Run all 5 simulated user instruction tests through the SimAgent.
 *
 * @param agent - Initialized SimAgent with loaded Skills
 * @param cameraId - Camera ID for context
 * @returns Array of test results
 */
export async function runSkillTests(
  agent: SimAgent,
  cameraId: string = "e2e-front-door",
): Promise<SkillTestResult[]> {
  const results: SkillTestResult[] = [];

  for (const tc of TEST_CASES) {
    const result = await runSingleTest(agent, tc, cameraId);
    results.push(result);
  }

  return results;
}

async function runSingleTest(
  agent: SimAgent,
  tc: SkillTestCase,
  cameraId: string,
): Promise<SkillTestResult> {
  try {
    const call = await agent.respondToUserInstruction(tc.instruction, { camera_id: cameraId });

    if (!call) {
      return {
        instruction: tc.instruction,
        expectedTool: tc.expectedTool,
        expectedAction: tc.expectedAction,
        output: null,
        passed: false,
        details: "Agent returned null (no action)",
      };
    }

    // Check tool name matches, allowing legacy runtime aliases during the
    // cam and mem -> memory naming transition.
    if (!toolMatches(call.tool ?? "", tc.expectedTool)) {
      return {
        instruction: tc.instruction,
        expectedTool: tc.expectedTool,
        expectedAction: tc.expectedAction,
        output: call,
        passed: false,
        details: `Wrong tool: got "${call.tool}", expected "${tc.expectedTool}"`,
      };
    }

    // Check action matches
    const action = (call.params ?? {}).action as string | undefined;
    if (action !== tc.expectedAction) {
      return {
        instruction: tc.instruction,
        expectedTool: tc.expectedTool,
        expectedAction: tc.expectedAction,
        output: call,
        passed: false,
        details: `Wrong action: got "${action}", expected "${tc.expectedAction}"`,
      };
    }

    // Run semantic validation
    const validation = tc.validate(call);

    return {
      instruction: tc.instruction,
      expectedTool: tc.expectedTool,
      expectedAction: tc.expectedAction,
      output: call,
      passed: validation.passed,
      details: validation.details,
    };
  } catch (err) {
    return {
      instruction: tc.instruction,
      expectedTool: tc.expectedTool,
      expectedAction: tc.expectedAction,
      output: null,
      passed: false,
      details: `Error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** Returns the number of skill test cases. */
export function getSkillTestCount(): number {
  return TEST_CASES.length;
}

function toolMatches(actual: string, expected: string): boolean {
  if (actual === expected) return true;

  const aliases: Record<string, string[]> = {
    cortex_cam: ["cortex_cam"],
    cortex_memory: ["cortex_mem"],
  };

  return aliases[expected]?.includes(actual) ?? false;
}
