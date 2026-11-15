/**
 * Mock event injector — sends simulated Cortex pipeline events
 * via HTTP POST to /api/monitor/inject for UI testing.
 *
 * Usage: npx tsx scripts/mock-events.ts
 */

const API_URL = "http://localhost:3210/api/monitor/inject";

const cameras = ["front_door", "backyard", "garage"];
const appearances = [
  "person in blue jacket",
  "person in black hoodie",
  "delivery driver with brown package",
  "woman with red umbrella",
  "child on bicycle",
];
const summaries = [
  "A person in a blue jacket approached the front door and left a package on the porch.",
  "Two people walking on the sidewalk, one carrying groceries.",
  "A delivery truck parked in the driveway, driver approaching the door.",
  "Cat sitting on the porch railing, no human activity.",
  "Person jogging past the house, no interaction with property.",
  "Unknown individual standing near the mailbox for approximately 2 minutes.",
  "Neighbor walking their dog past the front yard.",
  "Vehicle pulled into driveway, driver exited and entered garage.",
];

let segCounter = 1;
let eventCounter = 1;

function rand<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

type MockEvent = {
  type: string;
  timestamp: number;
  camera_id?: string;
  data: Record<string, unknown>;
};

async function inject(events: MockEvent[]): Promise<void> {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(events),
  });
  if (!res.ok) throw new Error(`Inject failed: ${res.status}`);
}

function buildPipelineCycle(): MockEvent[] {
  const cam = rand(cameras);
  const segId = `seg_${Date.now()}_${segCounter++}`;
  const evtId = `evt_${eventCounter++}`;
  const mode = rand(["event", "stream", "snapshot"] as const);
  const frameCount = mode === "snapshot" ? 1 : randInt(3, 12);
  const level = mode === "snapshot" ? 0 : 1;
  const summary = rand(summaries);
  const isRisk = Math.random() < 0.15;
  const notifyUser = Math.random() < 0.4;
  const vlmLatency = randInt(800, 3500);
  const targetCount = randInt(1, 4);

  return [
    {
      type: "cam:segment_built",
      timestamp: Date.now(),
      camera_id: cam,
      data: { segment_id: segId, mode, frame_count: frameCount, duration_sec: frameCount / 2 },
    },
    {
      type: "perception:analysis_started",
      timestamp: Date.now(),
      camera_id: cam,
      data: { segment_id: segId, mode, level, vlm_model: "gemini-2.5-flash" },
    },
    {
      type: "perception:working_memory_updated",
      timestamp: Date.now(),
      camera_id: cam,
      data: { camera_id: cam, event_id: evtId, scene_context_length: randInt(200, 1800) },
    },
    {
      type: "perception:vlm_result",
      timestamp: Date.now(),
      camera_id: cam,
      data: {
        segment_id: segId,
        summary,
        security_risk: isRisk,
        notify_user: notifyUser,
        is_static_scene: false,
        main_targets_count: targetCount,
        main_targets: Array.from({ length: targetCount }, () => ({
          type: rand(["person", "vehicle", "animal", "package"]),
          appearance: rand(appearances),
        })),
      },
    },
    {
      type: "perception:notification_resolved",
      timestamp: Date.now(),
      camera_id: cam,
      data: {
        segment_id: segId,
        notification_count: notifyUser ? 1 : 0,
        types: notifyUser ? ["summary"] : [],
        policy: rand(["smart", "always", "security_only"]),
      },
    },
    {
      type: "perception:analysis_completed",
      timestamp: Date.now(),
      camera_id: cam,
      data: { segment_id: segId, summary, level, vlm_latency_ms: vlmLatency },
    },
    {
      type: "memory:memory_added",
      timestamp: Date.now(),
      camera_id: cam,
      data: {
        camera_id: cam,
        mode,
        event_id: evtId,
        summary_preview: summary.slice(0, 100),
        memory_type: rand(["episodic", "semantic", "procedural"]),
      },
    },
    {
      type: "system:pipeline_metrics",
      timestamp: Date.now(),
      camera_id: cam,
      data: {
        segment_id: segId,
        camera_id: cam,
        mode,
        level,
        vlm_latency_ms: vlmLatency,
        vlm_model: "gemini-2.5-flash",
        notify_user: notifyUser,
        notification_count: notifyUser ? 1 : 0,
        policy: "smart",
      },
    },
  ];
}

async function main() {
  console.log("Injecting mock events via HTTP...\n");

  // Initial: source + watch events
  const initEvents: MockEvent[] = [];
  for (const cam of cameras) {
    initEvents.push({
      type: "cam:source_added",
      timestamp: Date.now(),
      camera_id: cam,
      data: { name: cam, id: cam, protocol: "ffmpeg", input: `rtsp://192.168.1.${randInt(100, 200)}/stream` },
    });
    initEvents.push({
      type: "cam:watch_started",
      timestamp: Date.now(),
      camera_id: cam,
      data: { name: cam, mode: "stream", fps: 2 },
    });
  }
  initEvents.push({
    type: "system:service_health",
    timestamp: Date.now(),
    data: { services: { qdrant: "ok", cortex: "ok", go2rtc: "ok" } },
  });

  await inject(initEvents);
  console.log(`  Injected ${initEvents.length} init events (sources + watches + health)\n`);

  // Pipeline cycles every 3 seconds
  let cycle = 1;
  const interval = setInterval(async () => {
    try {
      const events = buildPipelineCycle();
      await inject(events);
      const cam = events[0].camera_id;
      const summary = (events.find(e => e.type === "perception:vlm_result")?.data.summary as string)?.slice(0, 60);
      console.log(`  Cycle ${cycle++}: ${events.length} events [${cam}] — ${summary}...`);

      // Health every 5 cycles
      if (cycle % 5 === 0) {
        await inject([{
          type: "system:service_health",
          timestamp: Date.now(),
          data: { services: { qdrant: "ok", cortex: "ok", go2rtc: "ok" } },
        }]);
      }
    } catch (err) {
      console.error("Inject error:", err);
    }
  }, 3000);

  // Run for 2 minutes
  setTimeout(() => {
    clearInterval(interval);
    console.log(`\nDone. Sent ${cycle - 1} pipeline cycles.`);
    process.exit(0);
  }, 120_000);

  process.on("SIGINT", () => {
    clearInterval(interval);
    console.log(`\nStopped. Sent ${cycle - 1} pipeline cycles.`);
    process.exit(0);
  });
}

main().catch(console.error);
