/**
 * OpenClaw Agent Simulator
 *
 * Simulates how the OpenClaw Agent would use Cortex tools
 * based on the global SKILL.md orchestration guide.
 *
 * Runs against real services (Cortex + Qdrant).
 */
import { CortexClient } from "../packages/mem/src/client.ts";
import { flattenSearchResults } from "../packages/mem/src/types.ts";

const mem = new CortexClient({ baseUrl: "http://localhost:8219", timeoutMs: 30_000 });

// ── Simulated tool registry (what OpenClaw would have) ─────────────────

interface ToolCall {
  tool: string;
  action: string;
  params: Record<string, unknown>;
}

interface ToolResult {
  success: boolean;
  data: unknown;
}

async function executeToolCall(call: ToolCall): Promise<ToolResult> {
  switch (call.tool) {
    case "cortex_memory": {
      switch (call.action) {
        case "search": {
          const resp = await mem.search({
            query: call.params.query as string,
            user_id: "default",
            camera_id: call.params.camera_id as string | undefined,
            limit: (call.params.limit as number) ?? 5,
          });
          const results = flattenSearchResults(resp);
          return { success: true, data: results };
        }
        case "add_note": {
          const resp = await mem.add({
            video_data: { summary: call.params.note as string },
            camera_id: call.params.camera_id as string,
            user_id: "default",
            mode: "periodic",
          });
          return { success: true, data: resp };
        }
        case "get_history": {
          const resp = await mem.search({
            query: "*",
            user_id: "default",
            camera_id: call.params.camera_id as string,
            limit: (call.params.limit as number) ?? 10,
          });
          const results = flattenSearchResults(resp);
          return { success: true, data: results };
        }
        default:
          return { success: false, data: `Unknown memory action: ${call.action}` };
      }
    }

    case "cortex_cam": {
      // Simulate cam tool (no real camera connected in this test)
      switch (call.action) {
        case "list_sources":
          return { success: true, data: { sources: [
            { name: "front_door", protocol: "rtsp", status: "active" },
            { name: "my_phone", protocol: "phone", status: "connected" },
          ]}};
        case "snapshot":
          return { success: true, data: {
            source: call.params.name,
            image: "<base64_jpeg_simulated>",
            timestamp: Date.now(),
            description: "[simulated] Front door area, daytime, no people visible, a package on the ground",
          }};
        case "add_source":
          return { success: true, data: {
            name: call.params.name,
            source: call.params.source,
            status: "connected",
            ...(call.params.source === "phone" ? { nodeUrl: "https://rtc.reflect.world/node/simulated123" } : {}),
          }};
        case "start_watch":
          return { success: true, data: {
            name: call.params.name,
            mode: call.params.mode,
            status: "watching",
            message: "Pipeline started: Cam -> Perception -> Cortex + Act",
          }};
        case "stop_watch":
          return { success: true, data: { name: call.params.name, status: "stopped" }};
        default:
          return { success: false, data: `Unknown cam action: ${call.action}` };
      }
    }

    case "cortex_perception": {
      switch (call.action) {
        case "analyze":
          return { success: true, data: {
            event_id: `evt_${Date.now().toString(36)}`,
            perception_memory: {
              summary: "[simulated] A delivery person placed a package at the front door",
              perception_level: 1,
              entities: [{ type: "person", appearance: "brown uniform" }],
            },
            media_urls: { raw: "s3://raw-video/sim.mp4", keyframes: [], crops: [] },
          }};
        case "get_status":
          return { success: true, data: {
            camera_id: call.params.camera_id,
            active_event: null,
            segments_processed: 42,
            working_memory_size: 3,
          }};
        default:
          return { success: false, data: `Unknown perception action: ${call.action}` };
      }
    }

    case "cortex_act": {
      switch (call.action) {
        case "add_rule":
          return { success: true, data: {
            rule_id: `rule_${Date.now().toString(36)}`,
            trigger: call.params.trigger,
            actions: call.params.actions,
            status: "enabled",
          }};
        case "list_rules":
          return { success: true, data: { rules: [
            { id: "rule_default_1", trigger: { conditions: {} }, actions: { store_episodic: true }, enabled: true },
            { id: "rule_default_2", trigger: { conditions: { security_risk: true } }, actions: { notify: { type: "alert" } }, enabled: true },
          ]}};
        case "notify":
          return { success: true, data: { sent: true, type: call.params.type, message: call.params.message }};
        default:
          return { success: false, data: `Unknown act action: ${call.action}` };
      }
    }

    default:
      return { success: false, data: `Unknown tool: ${call.tool}` };
  }
}

// ── Agent decision engine (follows SKILL.md flowchart) ─────────────────

interface AgentResponse {
  thinking: string;
  toolCalls: ToolCall[];
  reply: string;
}

async function agentProcess(userMessage: string): Promise<AgentResponse> {
  const msg = userMessage.toLowerCase();

  // Pattern 1: Asking about past events → memory search
  if (matchesIntent(msg, ["yesterday", "last", "previous", "someone", "who came", "what happened",
      "happened", "visitors", "records", "history", "recently", "today",
      "did anyone", "when", "how many times", "suspicious"])) {
    const call: ToolCall = { tool: "cortex_memory", action: "search", params: { query: userMessage, limit: 5 } };
    const result = await executeToolCall(call);
    const results = result.data as Array<{ memory: string; score: number }>;
    const reply = results.length > 0
      ? formatMemoryResults(results)
      : "I don't recall seeing anything matching that. Is the camera monitoring active?";
    return {
      thinking: `User is asking about past events → SKILL.md Pattern 1 (Query) → cortex_memory.search`,
      toolCalls: [call],
      reply,
    };
  }

  // Pattern 2: Asking about current state → cam snapshot
  if (matchesIntent(msg, ["what's happening", "look", "show me", "take a photo",
      "snapshot", "current", "outside", "now"])) {
    const call: ToolCall = { tool: "cortex_cam", action: "snapshot", params: { name: "front_door" } };
    const result = await executeToolCall(call);
    const data = result.data as { description: string };
    return {
      thinking: `User wants to see current state → SKILL.md Pattern 2 (Live view) → cortex_cam.snapshot`,
      toolCalls: [call],
      reply: data.description.replace("[simulated] ", "I can see: "),
    };
  }

  // Pattern 5: Set up camera → cam add_source
  if (matchesIntent(msg, ["connect", "add camera", "add source", "phone",
      "webcam", "camera", "set up"])) {
    const isPhone = matchesIntent(msg, ["phone"]);
    const source = isPhone ? "phone" : "webcam";
    const name = isPhone ? "my_phone" : "my_webcam";
    const call: ToolCall = { tool: "cortex_cam", action: "add_source", params: { source, name } };
    const result = await executeToolCall(call);
    const data = result.data as { name: string; nodeUrl?: string };
    const reply = isPhone
      ? `Phone camera "${data.name}" is set up. Please open this URL to connect: ${data.nodeUrl}`
      : `Webcam "${data.name}" is connected and ready. Want me to take a test snapshot?`;
    return {
      thinking: `User wants to add a camera → SKILL.md Pattern 5 (Device onboarding) → cortex_cam.add_source`,
      toolCalls: [call],
      reply,
    };
  }

  // Pattern 3: Start monitoring → cam start_watch
  if (matchesIntent(msg, ["watch", "monitor", "start", "keep an eye on",
      "every", "periodic", "when there is motion"])) {
    const mode = matchesIntent(msg, ["every", "periodic", "minute"]) ? "periodic"
      : matchesIntent(msg, ["motion", "event"]) ? "event" : "stream";
    const call: ToolCall = {
      tool: "cortex_cam", action: "start_watch",
      params: { name: "front_door", mode, ...(mode === "periodic" ? { interval: 60 } : {}) },
    };
    const result = await executeToolCall(call);
    const data = result.data as { mode: string };
    return {
      thinking: `User wants monitoring → SKILL.md Pattern 3 (Monitor setup) → cortex_cam.start_watch(mode=${data.mode})`,
      toolCalls: [call],
      reply: `Monitoring started in ${data.mode} mode. I'll watch the front door and notify you if anything happens. The pipeline runs automatically: capture → analyze → store → notify.`,
    };
  }

  // Pattern 4: Set up automation rule → act add_rule
  if (matchesIntent(msg, ["notify me", "notify", "alert", "remind", "rule",
      "when someone arrives", "when someone appears"])) {
    const isSecurityRule = matchesIntent(msg, ["stranger", "unfamiliar", "suspicious"]);
    const trigger = isSecurityRule
      ? { type: "perception_event", conditions: { has_unfamiliar: true } }
      : { type: "perception_event", conditions: {} };
    const actions = isSecurityRule
      ? { notify: { type: "alert" }, identify: true }
      : { notify: { type: "summary", template: userMessage } };
    const call: ToolCall = { tool: "cortex_act", action: "add_rule", params: { trigger, actions } };
    await executeToolCall(call);
    return {
      thinking: `User wants automation → SKILL.md Pattern 4 (Rule setup) → cortex_act.add_rule`,
      toolCalls: [call],
      reply: isSecurityRule
        ? "Rule created. I'll send an alert and request identification when an unfamiliar person appears."
        : `Rule created. I'll notify you when this condition is met: "${userMessage}"`,
    };
  }

  // Fallback
  return {
    thinking: "No clear intent matched → ask for clarification",
    toolCalls: [],
    reply: "I'm not sure what you'd like me to do. I can: look at a camera, search my memories, start monitoring, or set up alerts. What would you like?",
  };
}

function matchesIntent(msg: string, keywords: string[]): boolean {
  return keywords.some(k => msg.includes(k));
}

function formatMemoryResults(results: Array<{ memory: string; score: number }>): string {
  if (results.length === 0) return "I don't have any records of that.";
  const lines = results.slice(0, 3).map(r => {
    const summary = String(r.memory).split("\n")[0].replace("summary: ", "");
    const confidence = r.score > 0.8 ? "" : r.score > 0.5 ? " (not very certain)" : " (low confidence)";
    return `  - ${summary}${confidence}`;
  });
  return `Here's what I remember:\n${lines.join("\n")}`;
}

// ── Test scenarios ─────────────────────────────────────────────────────

const scenarios = [
  // Pattern 1: Query
  "Did anyone visit yesterday?",
  "Did anyone suspicious appear?",
  "When did the courier arrive?",

  // Pattern 2: Live view
  "Show me what is happening at the front door now",

  // Pattern 5: Device setup
  "Connect my phone camera",

  // Pattern 3: Monitoring
  "Check the front door every five minutes",
  "Record whenever there is motion",

  // Pattern 4: Rule setup
  "Alert me when a stranger appears",
  "Notify me when Alex arrives",

  // Fallback
  "Hello",
];

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║           OpenClaw Agent Simulator (Cortex)                ║");
  console.log("║     Following skills/cortex/SKILL.md orchestration        ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  for (const query of scenarios) {
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`User: "${query}"`);
    console.log();

    const response = await agentProcess(query);

    console.log(`  [Agent thinking] ${response.thinking}`);
    if (response.toolCalls.length > 0) {
      for (const tc of response.toolCalls) {
        console.log(`  [Tool call] ${tc.tool}.${tc.action}(${JSON.stringify(tc.params)})`);
      }
    } else {
      console.log(`  [No tool call]`);
    }
    console.log();
    console.log(`  Agent: ${response.reply}`);
    console.log();
  }
}

main().catch((e) => { console.error("FAILED:", e); process.exit(1); });
